// Tournament runner: N rotations of a model lineup over one world, so every
// model plays every city and geography doesn't bias the comparison. Each run
// writes a full record (outcomes, structured events, population series, seat
// journals, usage); the batch ends with a per-model summary — the dataset
// behind the headline chart.
//
//   op run --env-file=agent.env -- npm run tournament -- \
//     --lineup "anthropic:claude-opus-5,anthropic:claude-sonnet-5,zai:glm-5.2,scripted:honest" \
//     --scenario scenarios/kilnspire-ledger-424242.json --ticks 100
//
// Seat specs: anthropic:<model>, zai:<model>, openai:<model>, opencode:<model>,
// scripted:honest, scripted:opportunist. Lineup length must equal city count.
// Prefer a direct provider route over the opencode gateway: it caps GLM into
// failure, and it under-reports GPT usage while billing for it.
import fs from 'node:fs';
import path from 'node:path';
import { defaultConfig } from '../src/engine/config';
import { Simulation } from '../src/engine/sim';
import { ScriptedSeat } from '../src/engine/seats/scripted';
import { createLLMSeat, type LLMSeat } from '../src/llm/factory';
import { RNG } from '../src/engine/rng';
import { generateTerrain } from '../src/engine/terrain';
import { configForScenario, type Scenario } from '../src/engine/scenario';
import { buildViewerHtml } from '../src/chronicle/html';
import type { Chronicle } from '../src/chronicle/types';
import { RESOURCES, type Resource, type Seat, type WorldEvent } from '../src/engine/types';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const lineup = arg('lineup', 'anthropic:claude-opus-5,anthropic:claude-sonnet-5,zai:glm-5.2,scripted:honest')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const scenarioPath = arg('scenario', '');
const ticks = Number(arg('ticks', '100'));
const rotations = Number(arg('rotations', String(lineup.length)));
const budget = Number(arg('budget', '2000000')); // tokens per LLM seat per run
// Resilience: --outDir reuses a directory, --startRotation skips completed
// rotations (their chronicle-rot*.json files are loaded from disk), so a
// killed run resumes at rotation granularity.
const outDirArg = arg('outDir', '');
const startRotation = Number(arg('startRotation', '0'));

interface SeatResult {
  spec: string;
  cityId: string;
  cityName: string;
  status: string;
  finalPop: number;
  collapsedTick?: number;
  agreements: number;
  reliability: { promised: number; delivered: number };
  defectionsCommitted: number;
  defectionsSuffered: number;
  // ADR-004. finalCeiling over finalPop is the risk-appetite reading: room
  // bought and filled is a good call, room bought and left empty is not.
  materialsBuilt: number;
  ceilingSteps: number;
  finalCeiling: number;
  usage?: unknown;
  cost?: number;
  retries?: number;
  failures?: number;
  adaptations?: number;
  journal?: string;
}

interface RunResult {
  rotation: number;
  ticksRun: number;
  assignment: Record<string, string>; // cityId → spec
  firstDefection?: { tick: number; cityId: string; spec: string };
  seats: SeatResult[];
  events: WorldEvent[];
  popSeries: Record<string, number[]>; // cityId → pop per tick
}

async function runOne(rotation: number, scenario: Scenario | undefined, outDir: string): Promise<RunResult> {
  const cfg = scenario ? configForScenario(scenario) : defaultConfig(Number(arg('seed', '20260725')));
  cfg.opportunistCount = 0;
  const sim = new Simulation(cfg, scenario);
  if (lineup.length !== sim.cities.length) {
    throw new Error(`lineup has ${lineup.length} seats but the world has ${sim.cities.length} cities`);
  }
  const rng = new RNG(cfg.seed ^ 0x9e3779b9);

  const assignment: Record<string, string> = {};
  const seats = new Map<string, Seat>();
  const llmSeats = new Map<string, LLMSeat>();
  sim.cities.forEach((c, i) => {
    const spec = lineup[(i + rotation) % lineup.length];
    assignment[c.id] = spec;
    if (spec.startsWith('scripted:')) {
      const personality = spec.endsWith('opportunist') ? 'opportunist' : 'honest';
      seats.set(c.id, new ScriptedSeat(c.id, personality, rng));
    } else {
      const seat = createLLMSeat(spec, c.id, { logDir: outDir, runId: `rot${rotation}`, tokenBudget: budget });
      seats.set(c.id, seat);
      llmSeats.set(c.id, seat);
    }
  });

  console.log(`\n── rotation ${rotation} ──`);
  for (const c of sim.cities) console.log(`   ${c.name} (${c.produces.join('+')}) ← ${assignment[c.id]}`);

  // Pause support: `touch <outDir>/PAUSE` idles the run between ticks (no
  // API calls, nothing lost); remove the file to continue.
  const pauseFile = path.join(outDir, 'PAUSE');
  const maybePause = async (): Promise<void> => {
    if (!fs.existsSync(pauseFile)) return;
    console.log(`paused (${new Date().toISOString()}) — remove ${pauseFile} to continue`);
    while (fs.existsSync(pauseFile)) await new Promise((r) => setTimeout(r, 10_000));
    console.log(`resumed (${new Date().toISOString()})`);
  };

  const popSeries: Record<string, number[]> = Object.fromEntries(sim.cities.map((c) => [c.id, []]));
  const ceilingSeries: Record<string, number[]> = Object.fromEntries(sim.cities.map((c) => [c.id, []]));
  const buildSeries: Record<string, number[]> = Object.fromEntries(sim.cities.map((c) => [c.id, []]));
  const buildSpend: Record<string, number> = Object.fromEntries(sim.cities.map((c) => [c.id, 0]));
  const stockpileSeries: Record<string, Record<Resource, number[]>> = Object.fromEntries(
    sim.cities.map((c) => [c.id, { food: [], energy: [], materials: [] }]),
  );
  const journals: Record<string, Array<{ tick: number; text: string }>> = Object.fromEntries(
    sim.cities.map((c) => [c.id, []]),
  );
  const lastJournal: Record<string, string> = {};
  let seenEvents = 0;
  let t = 0;
  while (t < ticks) {
    await maybePause();
    t++;
    await sim.step(seats);
    for (const c of sim.cities) {
      popSeries[c.id].push(Math.round(c.population * 10) / 10);
      ceilingSeries[c.id].push(Math.round(sim.ceilingOf(c) * 10) / 10);
      const spent = sim.buildSpentThisTick.get(c.id) ?? 0;
      buildSeries[c.id].push(Math.round(spent * 10) / 10);
      buildSpend[c.id] += spent;
      for (const r of RESOURCES) stockpileSeries[c.id][r].push(Math.round(c.stockpiles[r] * 10) / 10);
      const j = sim.memoryOf(c.id);
      if (j && j !== lastJournal[c.id]) {
        journals[c.id].push({ tick: t, text: j });
        lastJournal[c.id] = j;
      }
    }
    for (const e of sim.events.slice(seenEvents)) {
      if (e.kind === 'defection' || e.kind === 'collapse' || e.kind === 'embargo') {
        console.log(`   t${t} [${e.kind}] ${e.text}`);
      }
    }
    seenEvents = sim.events.length;
    if (t % 10 === 0) {
      const pops = sim.cities
        .map((c) => `${c.name.slice(0, 5)}:${c.status === 'ruins' ? 'DEAD' : Math.round(c.population)}`)
        .join('  ');
      console.log(`   t${String(t).padStart(3)}  ${pops}`);
    }
    if (sim.aliveCities().length === 0) break;
  }

  const firstDef = sim.events.find((e) => e.kind === 'defection');
  const result: RunResult = {
    rotation,
    ticksRun: t,
    assignment,
    firstDefection: firstDef?.actor
      ? { tick: firstDef.tick, cityId: firstDef.actor, spec: assignment[firstDef.actor] }
      : undefined,
    seats: sim.cities.map((c) => {
      const llm = llmSeats.get(c.id);
      return {
        spec: assignment[c.id],
        cityId: c.id,
        cityName: c.name,
        status: c.status,
        finalPop: Math.round(c.population * 10) / 10,
        collapsedTick: c.collapsedTick,
        agreements: [...sim.agreements.values()].filter((a) => a.a === c.id || a.b === c.id).length,
        reliability: sim.reliabilityOf(c.id),
        defectionsCommitted: sim.events.filter((e) => e.kind === 'defection' && e.actor === c.id).length,
        defectionsSuffered: sim.events.filter((e) => e.kind === 'defection' && e.target === c.id).length,
        materialsBuilt: Math.round(buildSpend[c.id] * 10) / 10,
        ceilingSteps: Math.round(c.ceilingBonus / cfg.build.ceilingPerStep),
        finalCeiling: Math.round(sim.ceilingOf(c) * 10) / 10,
        usage: llm?.usage,
        cost: llm?.estimatedCost(),
        retries: llm?.stats.retries,
        failures: llm?.stats.failures,
        adaptations: llm?.stats.adaptations,
        journal: llm ? sim.memoryOf(c.id) : undefined,
      };
    }),
    events: sim.events,
    popSeries,
  };
  fs.writeFileSync(path.join(outDir, `run-rot${rotation}.json`), JSON.stringify(result, null, 2) + '\n');

  // The Chronicle (ADR-002): full post-hoc record of this rotation.
  const chronicle: Chronicle = {
    version: 1,
    rotation,
    ticksRun: t,
    world: {
      scenarioName: scenario?.name,
      premise: scenario?.premise,
      designNotes: scenario?.designNotes,
      seed: cfg.seed,
      gridSize: cfg.gridSize,
    },
    cities: sim.cities.map((c, i) => ({
      id: c.id,
      name: c.name,
      color: c.color,
      site: { ...c.site },
      produces: [...c.produces] as [Resource, Resource],
      lore: scenario?.cities[i]?.lore,
    })),
    shocks: scenario?.shocks,
    assignment,
    firstDefection: result.firstDefection,
    seats: result.seats.map(({ journal: _journal, usage: _usage, ...rest }) => rest),
    events: sim.events,
    messages: sim.messageLog,
    journals,
    popSeries,
    ceilingSeries,
    buildSeries,
    stockpileSeries,
    offers: [...sim.offers.values()].map((o) => ({
      id: o.id,
      from: o.from,
      to: o.to,
      give: { ...o.give },
      receive: { ...o.receive },
      duration: o.duration,
      createdTick: o.createdTick,
      expiresTick: o.expiresTick,
      status: o.status,
    })),
    agreements: [...sim.agreements.values()].map((a) => ({
      id: a.id,
      a: a.a,
      b: a.b,
      aGives: { ...a.aGives },
      bGives: { ...a.bGives },
      startTick: a.startTick,
      endTick: a.endTick,
      fulfillment: Object.fromEntries(Object.entries(a.fulfillment).map(([k, v]) => [k, { ...v }])),
    })),
  };
  fs.writeFileSync(path.join(outDir, `chronicle-rot${rotation}.json`), JSON.stringify(chronicle) + '\n');
  chronicles.push(chronicle);
  return result;
}

const chronicles: Chronicle[] = [];

interface ModelAgg {
  runs: number;
  survived: number;
  popSum: number;
  promised: number;
  delivered: number;
  defCommitted: number;
  defSuffered: number;
  firstDefections: number;
  cost: number;
  retries: number;
  failures: number;
  materialsBuilt: number;
  ceilingSteps: number;
  ceilingSum: number;
}

async function main(): Promise<void> {
  const scenario = scenarioPath ? (JSON.parse(fs.readFileSync(scenarioPath, 'utf8')) as Scenario) : undefined;
  const outDir = outDirArg || path.join('runs', `tournament-${Date.now()}`);
  fs.mkdirSync(outDir, { recursive: true });
  for (let r = 0; r < startRotation; r++) {
    const f = path.join(outDir, `chronicle-rot${r}.json`);
    if (!fs.existsSync(f)) throw new Error(`--startRotation ${startRotation} but ${f} is missing`);
    chronicles.push(JSON.parse(fs.readFileSync(f, 'utf8')) as Chronicle);
    console.log(`resumed rotation ${r} from disk`);
  }

  console.log(`POLIS tournament — ${rotations} rotation(s) × ${ticks} ticks`);
  console.log(`world: ${scenario ? `${scenario.name} (seed ${scenario.seed})` : `procedural seed ${arg('seed', '20260725')}`}`);
  console.log(`lineup: ${lineup.join('  ')}`);
  console.log(`output: ${outDir}`);

  const results: RunResult[] = [];
  for (let r = startRotation; r < rotations; r++) {
    results.push(await runOne(r, scenario, outDir));
  }

  const byModel = new Map<string, ModelAgg>();
  // Aggregate from chronicles (includes disk-resumed rotations).
  const chronicleSeats = chronicles.map((c) => ({ seats: c.seats, firstDefection: c.firstDefection }));
  for (const run of chronicleSeats) {
    for (const s of run.seats) {
      const m =
        byModel.get(s.spec) ??
        ({ runs: 0, survived: 0, popSum: 0, promised: 0, delivered: 0, defCommitted: 0, defSuffered: 0, firstDefections: 0, cost: 0, retries: 0, failures: 0, materialsBuilt: 0, ceilingSteps: 0, ceilingSum: 0 } as ModelAgg);
      m.runs++;
      if (s.status !== 'ruins') m.survived++;
      m.popSum += s.finalPop;
      m.promised += s.reliability.promised;
      m.delivered += s.reliability.delivered;
      m.defCommitted += s.defectionsCommitted;
      m.defSuffered += s.defectionsSuffered;
      if (run.firstDefection?.spec === s.spec && run.firstDefection.cityId === s.cityId) m.firstDefections++;
      m.cost += s.cost ?? 0;
      m.retries += s.retries ?? 0;
      m.failures += s.failures ?? 0;
      // Absent on chronicles written before ADR-004, so default rather than NaN.
      m.materialsBuilt += s.materialsBuilt ?? 0;
      m.ceilingSteps += s.ceilingSteps ?? 0;
      m.ceilingSum += s.finalCeiling ?? s.finalPop;
      byModel.set(s.spec, m);
    }
  }

  const summary = [...byModel.entries()].map(([spec, m]) => ({
    model: spec,
    runs: m.runs,
    survived: `${m.survived}/${m.runs}`,
    avgFinalPop: Math.round(m.popSum / m.runs),
    reliability: m.promised > 0 ? `${Math.round((m.delivered / m.promised) * 100)}%` : 'n/a',
    defected: m.defCommitted,
    shorted: m.defSuffered,
    firstDefector: m.firstDefections,
    materialsBuilt: Math.round(m.materialsBuilt),
    ceilingSteps: m.ceilingSteps,
    avgFinalCeiling: Math.round(m.ceilingSum / m.runs),
    // The risk-appetite reading. 100% means the room bought was filled; a low
    // number means materials went into a ceiling the city never grew into.
    ceilingUsed: m.ceilingSum > 0 ? `${Math.round((m.popSum / m.ceilingSum) * 100)}%` : 'n/a',
    retries: m.retries,
    failures: m.failures,
    cost: `$${m.cost.toFixed(2)}`,
  }));

  console.log('\n=== Tournament summary ===');
  console.table(summary);
  const totalCost = chronicles.flatMap((c) => c.seats).reduce((a, s) => a + (s.cost ?? 0), 0);
  console.log(`total cost: $${totalCost.toFixed(2)}`);

  fs.writeFileSync(
    path.join(outDir, 'summary.json'),
    JSON.stringify(
      { scenario: scenario?.name, seed: scenario?.seed, lineup, ticks, rotations, summary, totalCost },
      null,
      2,
    ) + '\n',
  );
  console.log(`wrote ${path.join(outDir, 'summary.json')}`);

  // Chronicle Viewer (ADR-002): one self-contained HTML file per tournament.
  const worldSeed = scenario?.seed ?? Number(arg('seed', '20260725'));
  const gridSize = scenario?.gridSize ?? 96;
  const terrain = generateTerrain(new RNG(worldSeed), gridSize);
  const html = buildViewerHtml({
    title: scenario?.name ?? `seed ${worldSeed}`,
    premise: scenario?.premise,
    designNotes: scenario?.designNotes,
    generatedAt: new Date().toISOString().slice(0, 16).replace('T', ' '),
    lineup,
    ticks,
    world: {
      size: gridSize,
      seaLevel: terrain.seaLevel,
      heights: Array.from(terrain.heights, (h) => Math.round(h * 1000) / 1000),
    },
    chronicles,
  });
  fs.writeFileSync(path.join(outDir, 'chronicle.html'), html);
  console.log(`wrote ${path.join(outDir, 'chronicle.html')}`);
}

await main();
