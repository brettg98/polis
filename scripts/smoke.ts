// Smoke test: one LLM-driven seat against three honest scripted seats.
// Verifies plumbing end to end: prompt, structured output, deliveries,
// offer/accept flow, journal round-trip, usage accounting.
//   npm run smoke -- --seat anthropic:claude-opus-5 --ticks 12 --seed 20260725
//   npm run smoke -- --seat zai:glm-5.2
//   npm run smoke -- --seat openai:gpt-5.6-terra
import fs from 'node:fs';
import { defaultConfig } from '../src/engine/config';
import { Simulation } from '../src/engine/sim';
import { ScriptedSeat } from '../src/engine/seats/scripted';
import { createLLMSeat } from '../src/llm/factory';
import { RNG } from '../src/engine/rng';
import { configForScenario, type Scenario } from '../src/engine/scenario';
import type { Seat } from '../src/engine/types';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const seatSpec = arg('seat', 'anthropic:claude-opus-5');
const ticks = Number(arg('ticks', '12'));
const scenarioPath = arg('scenario', '');

async function main(): Promise<void> {
  const scenario = scenarioPath ? (JSON.parse(fs.readFileSync(scenarioPath, 'utf8')) as Scenario) : undefined;
  const seed = scenario ? scenario.seed : Number(arg('seed', '20260725'));
  const cfg = scenario ? configForScenario(scenario) : defaultConfig(seed);
  cfg.opportunistCount = 0; // all-honest scripted seats so any drama is the LLM's
  const sim = new Simulation(cfg, scenario);
  const rng = new RNG(cfg.seed ^ 0x9e3779b9);
  if (scenario) console.log(`Scenario: ${scenario.name} — ${scenario.premise}\n`);

  const llmCity = sim.cities[0];
  const llmSeat = createLLMSeat(seatSpec, llmCity.id, {
    logDir: 'runs',
    tokenBudget: 500_000,
    runId: `smoke-${seed}-${Date.now()}`,
  });

  const seats = new Map<string, Seat>();
  for (const c of sim.cities) {
    seats.set(c.id, c.id === llmCity.id ? llmSeat : new ScriptedSeat(c.id, 'honest', rng));
  }

  const deficit = ['food', 'energy', 'materials'].find((r) => !llmCity.produces.includes(r as never));
  console.log(`POLIS smoke test — seed ${seed}, ${ticks} ticks`);
  console.log(`LLM seat: ${llmCity.name} (${llmCity.id}) on ${llmSeat.label}, produces ${llmCity.produces.join('+')}, needs ${deficit}`);
  console.log(`Scripted: ${sim.cities.filter((c) => c.id !== llmCity.id).map((c) => c.name).join(', ')} (honest)\n`);

  let seenEvents = 0;
  for (let t = 1; t <= ticks; t++) {
    await sim.step(seats);
    const pops = sim.cities
      .map((c) => `${c.name.slice(0, 5)}:${c.status === 'ruins' ? 'DEAD' : Math.round(c.population)}`)
      .join('  ');
    console.log(`t${String(t).padStart(2)}  ${pops}`);
    for (const e of sim.events.slice(seenEvents)) {
      console.log(`      [${e.kind}] ${e.text}`);
    }
    seenEvents = sim.events.length;
  }

  const llmAgreements = [...sim.agreements.values()].filter((a) => a.a === llmCity.id || a.b === llmCity.id);
  const rel = sim.reliabilityOf(llmCity.id);
  const relPct = rel.promised > 0 ? `${Math.round((rel.delivered / rel.promised) * 100)}%` : 'n/a (nothing promised yet)';
  const city = sim.city(llmCity.id);

  console.log(`\n=== Smoke summary ===`);
  console.log(`${city.name}: ${city.status}, pop ${Math.round(city.population)} (started 100)`);
  console.log(
    `stockpiles: food ${Math.round(city.stockpiles.food)}, energy ${Math.round(city.stockpiles.energy)}, materials ${Math.round(city.stockpiles.materials)} (deficit resource: ${deficit})`,
  );
  console.log(`agreements involving LLM city: ${llmAgreements.length}, delivery reliability: ${relPct}`);
  const steps = Math.round(city.ceilingBonus / cfg.build.ceilingPerStep);
  console.log(
    `building: ceiling ${Math.round(sim.ceilingOf(city))} (base 150, ${steps} step${steps === 1 ? '' : 's'} bought), ` +
      `${Math.round(city.buildProgress)} banked, ${Math.round(sim.nextStepCost(city) - city.buildProgress)} more to the next step`,
  );
  console.log(`usage: ${llmSeat.usage.calls} calls, ${JSON.stringify(llmSeat.usage)} → ~$${llmSeat.estimatedCost().toFixed(3)}`);
  const journal = sim.memoryOf(llmCity.id);
  console.log(`\n--- ${city.name}'s final journal (${journal.length} chars) ---`);
  console.log(journal || '(empty)');
}

await main();
