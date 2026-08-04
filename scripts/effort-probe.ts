// Does reasoning effort actually do anything? One probe per provider (issue #21).
//
// docs/llm-seats.md calls equal reasoning effort an enforced fairness rule and
// ADR-005 rests on the equalisation in a4bfd5c having worked. Neither claim has
// been checked against a provider. Z.ai's reference already contradicts one half
// of it: on glm-5.2, `low` and `medium` are mapped to `high`, so the value the
// seat sends is accepted and then discarded. Whether the Anthropic half works is
// unknown, and that decides whether the correction reads "one provider ignored
// it" or "the mechanism never worked anywhere".
//
// Standalone on purpose. It imports the prompt, schema and validator so it asks
// exactly what a seat asks, but it builds its own HTTP calls rather than going
// through the seat classes, so REASONING_EFFORT and the seat layer are untouched
// and no tournament rule moves.
//
//   op run --env-file=agent.env -- npx tsx scripts/effort-probe.ts
//   ... --arms anthropic:claude-opus-5           # one model
//   ... --efforts none,minimal                   # one rung of the ladder
//   ... --repeats 5                              # n per cell, reports mean and sd
//   ... --dry-run                                # build and print the prompt, no calls
import fs from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { SYSTEM_PROMPT, observationToMessage } from '../src/llm/prompt';
import { SEAT_ACTION_SCHEMA } from '../src/llm/schema';
import { validateSeatAction } from '../src/llm/validate';
import { defaultConfig } from '../src/engine/config';
import { engineShocks, type Scenario } from '../src/engine/scenario';
import type { Chronicle } from '../src/chronicle/types';
import type {
  AgreementView,
  City,
  CityPublicView,
  Message,
  OfferView,
  Resource,
  ResourceSet,
  SeatAction,
  SeatObservation,
} from '../src/engine/types';

const RESOURCES: Resource[] = ['food', 'energy', 'materials'];

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

// ---------------------------------------------------------------------------
// Observations
//
// Rebuilt from a tournament chronicle rather than invented, because the
// "~2,200 output tokens" figure in llm-seats.md:154 was measured on a smoke
// test and does not survive tournament complexity — a real tick carries a
// four-entry ledger, an inbox, and a journal near the 4,000-character cap, and
// that is what the model actually has to reason about.
//
// Exact from the chronicle: population, stockpiles, ceiling, journal, inbox,
// offers, agreement terms, public events, shocks, city positions.
// Derived with the engine's own constants: production, consumption,
// stockpileCap, buildProgress, nextStepCost, ticksUntilShortage,
// transportEfficiency, apparentSize.
// Approximated, and the only two: per-tick agreement fulfilment counters are
// prorated from the run's final totals (the chronicle keeps totals only), and
// `unrest` is 0 (never recorded). Both are small scalars inside an otherwise
// real tick, and both are identical across every arm, which is what the
// comparison needs.
// ---------------------------------------------------------------------------

interface Fixture {
  label: string;
  provenance: string;
  obs: SeatObservation;
}

function buildObservation(ch: Chronicle, scenario: Scenario, cityId: string, tick: number): SeatObservation {
  const cfg = defaultConfig(scenario.seed);
  cfg.city.productionPerCapita = scenario.productionPerCapita;
  const cc = cfg.city;
  // Series index i holds state after tick i+1; a seat acting on tick T sees the
  // world as it stood after T-1.
  const idx = tick - 2;
  if (idx < 0) throw new Error('tick must be >= 2');

  // engineShocks only reads id and name off each city.
  const shocks = engineShocks(scenario, ch.cities as unknown as City[]);
  const me = ch.cities.find((c) => c.id === cityId);
  if (!me) throw new Error(`no city ${cityId} in chronicle`);

  const multiplier = (id: string, r: Resource): number => {
    let m = 1;
    for (const s of shocks) {
      if (tick < s.startTick || tick >= s.endTick) continue;
      if (s.targetId !== 'all' && s.targetId !== id) continue;
      if (s.resource !== 'all' && s.resource !== r) continue;
      m *= s.multiplier;
    }
    return m;
  };
  const popAt = (id: string): number => ch.popSeries[id][idx];
  const ceilingAt = (id: string): number => (ch.ceilingSeries ?? {})[id]?.[idx] ?? cc.startPopulation * cc.maxGrowthFactor;

  const population = popAt(cityId);
  const stockpiles = Object.fromEntries(
    RESOURCES.map((r) => [r, ch.stockpileSeries[cityId][r][idx]]),
  ) as ResourceSet;
  const production = Object.fromEntries(RESOURCES.map((r) => [r, 0])) as ResourceSet;
  for (const r of me.produces) production[r] = population * cc.productionPerCapita * multiplier(cityId, r);
  const consumption = Object.fromEntries(
    RESOURCES.map((r) => [r, population * cc.consumptionPerCapita]),
  ) as ResourceSet;

  // Build state: the ceiling gives the steps bought, the spend series gives the
  // total put in, and the difference is what is still banked toward the next.
  const ceiling = ceilingAt(cityId);
  const stepsCompleted = Math.round((ceiling - cc.startPopulation * cc.maxGrowthFactor) / cfg.build.ceilingPerStep);
  const spentTotal = (ch.buildSeries?.[cityId] ?? []).slice(0, idx + 1).reduce((a, b) => a + b, 0);
  let consumedBySteps = 0;
  for (let k = 0; k < stepsCompleted; k++) consumedBySteps += cfg.build.firstStepCost + cfg.build.stepCostIncrement * k;
  const buildProgress = Math.max(0, spentTotal - consumedBySteps);
  const nextStepCostTotal = cfg.build.firstStepCost + cfg.build.stepCostIncrement * stepsCompleted;

  // Agreements live at this tick, with fulfilment prorated across their span.
  const agreements: AgreementView[] = [];
  const inflow = Object.fromEntries(RESOURCES.map((r) => [r, 0])) as ResourceSet;
  const outflow = Object.fromEntries(RESOURCES.map((r) => [r, 0])) as ResourceSet;
  for (const ag of ch.agreements) {
    if (ag.endTick <= tick) continue;
    // An accepted offer becomes active two ticks later, so anything starting
    // beyond that had not been agreed yet and cannot be in this tick's ledger.
    // The chronicle records no creation tick; startTick is the only handle on it.
    if (ag.startTick > tick + 2) continue;
    if (ag.a !== cityId && ag.b !== cityId) continue;
    const mine = ag.a === cityId;
    const otherId = mine ? ag.b : ag.a;
    const span = Math.max(1, ag.endTick - ag.startTick);
    const frac = Math.min(1, Math.max(0, (tick - ag.startTick) / span));
    const prorate = (f: { promised: number; delivered: number } | undefined) => ({
      promised: Math.round((f?.promised ?? 0) * frac),
      delivered: Math.round((f?.delivered ?? 0) * frac),
    });
    if (ag.startTick <= tick) {
      outflow[(mine ? ag.aGives : ag.bGives).resource] += (mine ? ag.aGives : ag.bGives).qty;
      inflow[(mine ? ag.bGives : ag.aGives).resource] += (mine ? ag.bGives : ag.aGives).qty;
    }
    agreements.push({
      id: ag.id,
      counterparty: otherId,
      youGive: { ...(mine ? ag.aGives : ag.bGives) },
      youReceive: { ...(mine ? ag.bGives : ag.aGives) },
      ticksRemaining: ag.endTick - tick,
      deliveryDueNow: ag.startTick <= tick + 1 && tick + 1 < ag.endTick,
      yourFulfillment: prorate(ag.fulfillment[cityId]),
      theirFulfillment: prorate(ag.fulfillment[otherId]),
    });
  }

  const ticksUntilShortage: Partial<Record<Resource, number>> = {};
  for (const r of RESOURCES) {
    const net = consumption[r] + outflow[r] - production[r] - inflow[r];
    if (net > 0.0001) ticksUntilShortage[r] = Math.max(0, Math.floor(stockpiles[r] / net));
  }

  const eff = (a: { x: number; y: number }, b: { x: number; y: number }): number => {
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    return Math.round(Math.max(cfg.trade.transportEfficiencyFloor, 1 - cfg.trade.transportLossPerCell * d) * 1000) / 1000;
  };
  const others: CityPublicView[] = ch.cities
    .filter((o) => o.id !== cityId)
    .map((o) => {
      const pop = popAt(o.id);
      return {
        cityId: o.id,
        name: o.name,
        position: { ...o.site },
        produces: [...o.produces] as [Resource, Resource],
        apparentSize: pop < 70 ? 'small' : pop < 115 ? 'medium' : pop < 160 ? 'large' : 'huge',
        ceiling: ceilingAt(o.id),
        status: pop <= cc.startPopulation * cc.collapseFraction ? 'ruins' : 'alive',
        transportEfficiency: eff(me.site, o.site),
      };
    });

  const toView = (o: Chronicle['offers'][number]): OfferView => ({
    id: o.id,
    from: o.from,
    to: o.to,
    give: { ...o.give },
    receive: { ...o.receive },
    duration: o.duration,
    expiresTick: o.expiresTick,
  });
  const live = ch.offers.filter((o) => o.createdTick < tick && tick < o.expiresTick);

  // The journal is fed back verbatim from the previous tick; snapshots are
  // deduped, so take the newest one at or before then.
  const snaps = (ch.journals[cityId] ?? []).filter((j) => j.tick <= tick - 1);
  const memory = snaps.length ? snaps[snaps.length - 1].text : '';
  const inbox: Message[] = ch.messages.filter((m) => m.to === cityId && m.tick === tick - 1);

  return {
    tick,
    you: {
      cityId,
      name: me.name,
      produces: [...me.produces] as [Resource, Resource],
      stockpiles,
      stockpileCap: cc.stockpileCapTicks * cc.consumptionPerCapita * cc.startPopulation,
      production,
      consumption,
      population,
      ceiling,
      buildProgress,
      nextStepCost: Math.max(0, nextStepCostTotal - buildProgress),
      growthFloor: cc.growthGateTicks * population * cc.consumptionPerCapita,
      unrest: 0,
      status: RESOURCES.some((r) => stockpiles[r] < 0.05) ? 'struggling' : 'alive',
      ticksUntilShortage,
      forewarnings: shocks
        .filter(
          (s) =>
            s.privateWarning !== undefined &&
            s.targetId === cityId &&
            tick >= s.startTick - s.privateWarning &&
            tick < s.announceTick,
        )
        .map((s) => ({
          name: s.name,
          description: s.description,
          resource: s.resource,
          startTick: s.startTick,
          duration: s.duration,
          multiplier: s.multiplier,
        })),
    },
    world: {
      cities: others,
      shocks: shocks
        .filter((s) => tick >= s.announceTick && tick < s.endTick)
        .map((s) => ({
          name: s.name,
          description: s.description,
          target: s.targetId,
          resource: s.resource,
          startTick: s.startTick,
          duration: s.duration,
          multiplier: s.multiplier,
          status: (tick >= s.startTick ? 'active' : 'announced') as 'active' | 'announced',
        })),
      publicEvents: ch.events.filter((e) => e.isPublic && e.tick < tick).slice(-8),
    },
    ledger: {
      incomingOffers: live.filter((o) => o.to === cityId).map(toView),
      outgoingOffers: live.filter((o) => o.from === cityId).map(toView),
      agreements,
    },
    inbox,
    memory,
  };
}

// ---------------------------------------------------------------------------
// Arms
//
// Two observations per arm — one quiet tick and one crisis tick — because a
// null result on a single prompt is unreadable: the vendor documents effort as
// a behavioural signal rather than a token budget, so identical output could
// mean the parameter is ignored or that this prompt gives effort nothing to
// bite on. Varying the tick narrows that.
//
// GLM gets a `minimal` arm the Anthropic seats cannot have. It is the only
// setting Z.ai documents as actually skipping thinking, so it is the only
// candidate for bringing GLM near the Anthropic seats, and nothing has tested
// whether GLM still emits a valid action with thinking off.
// ---------------------------------------------------------------------------

type Arm = { spec: string; effort: string; disableThinking?: boolean };

const ARMS: Arm[] = [
  ...['low', 'high', 'max'].map((effort) => ({ spec: 'anthropic:claude-opus-5', effort })),
  ...['low', 'high', 'max'].map((effort) => ({ spec: 'anthropic:claude-sonnet-5', effort })),
  ...['none', 'minimal', 'low', 'high', 'max'].map((effort) => ({ spec: 'zai:glm-5.2', effort })),
  // The vendor's own off-switch, a separate field rather than a rung on the
  // ladder. Z.ai says reasoning_effort "takes effect when thinking is enabled",
  // so this arm sends no effort at all — anything else would measure a
  // parameter the provider has already told us it ignores here.
  { spec: 'zai:glm-5.2', effort: 'disabled', disableThinking: true },
  // Terra direct. The gateway route reports reasoning_tokens: 0 while billing
  // for them, so the ADR-006 bound — which is defined on output tokens — cannot
  // be checked there at all. `medium` is the provider default, so it is what
  // this seat ran at before any effort value was sent.
  ...['none', 'low', 'medium'].map((effort) => ({ spec: 'openai:gpt-5.6-terra', effort })),
];

const MAX_TOKENS = 16000; // identical to the seats

interface Result {
  spec: string;
  effort: string;
  fixture: string;
  rep: number;
  outputTokens: number;
  inputTokens: number;
  ms: number;
  finish: string;
  valid: boolean;
  problems: string;
}

type Measurement = Omit<Result, 'spec' | 'effort' | 'fixture' | 'rep'>;

async function callAnthropic(model: string, effort: string, obs: SeatObservation): Promise<Measurement> {
  const client = new Anthropic({ timeout: 300_000 });
  const started = Date.now();
  const resp = (await client.messages.create({
    model,
    max_tokens: MAX_TOKENS,
    system: [{ type: 'text', text: SYSTEM_PROMPT }],
    // effort rides inside output_config alongside the schema, exactly as
    // anthropicSeat.ts sends it. The seat's own option type only admits
    // low/medium/high, which is why xhigh and max have never been reachable
    // from a seat — the API accepts all five.
    output_config: { format: { type: 'json_schema', schema: SEAT_ACTION_SCHEMA }, effort },
    messages: [{ role: 'user', content: observationToMessage(obs) }],
  } as unknown as Anthropic.MessageCreateParamsNonStreaming)) as Anthropic.Message;
  const ms = Date.now() - started;
  const text = resp.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
  let valid = false;
  let problems = '';
  if (text) {
    try {
      const action = JSON.parse(text.text) as SeatAction;
      const p = validateSeatAction(action);
      valid = p.length === 0;
      problems = p.join('; ');
    } catch (err) {
      problems = `unparseable: ${String(err).slice(0, 120)}`;
    }
  } else {
    problems = 'no text block';
  }
  return {
    outputTokens: resp.usage.output_tokens ?? 0,
    inputTokens: resp.usage.input_tokens ?? 0,
    ms,
    finish: String(resp.stop_reason),
    valid,
    problems,
  };
}

async function callCompat(
  model: string,
  effort: string,
  obs: SeatObservation,
  baseUrl: string,
  keyEnv: string,
  disableThinking = false,
  // Each provider's steady state differs, and the probe has to sit in it or it
  // measures the adaptation rather than the effort. Z.ai accepts json_schema
  // with a 200 and ignores it, so the seat ends up on json_object with the
  // schema in the prompt. OpenAI keeps json_schema but rejects max_tokens for
  // reasoning models — taken from an actual smoke run's adaptation log, not
  // from the docs.
  shape: { mode: 'json_schema' | 'json_object'; tokenParam: 'max_tokens' | 'max_completion_tokens' } = {
    mode: 'json_object',
    tokenParam: 'max_tokens',
  },
): Promise<Measurement> {
  const key = process.env[keyEnv];
  if (!key) throw new Error(`${keyEnv} is not set`);
  const started = Date.now();
  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      [shape.tokenParam]: MAX_TOKENS,
      ...(disableThinking ? { thinking: { type: 'disabled' } } : { reasoning_effort: effort }),
      response_format:
        shape.mode === 'json_schema'
          ? { type: 'json_schema', json_schema: { name: 'seat_action', strict: true, schema: SEAT_ACTION_SCHEMA } }
          : { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            shape.mode === 'json_object'
              ? `${SYSTEM_PROMPT}\n\n# Action schema (respond with JSON matching exactly this)\n${JSON.stringify(SEAT_ACTION_SCHEMA)}`
              : SYSTEM_PROMPT,
        },
        { role: 'user', content: observationToMessage(obs) },
      ],
    }),
    signal: AbortSignal.timeout(300_000),
  });
  const ms = Date.now() - started;
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  const data = (await resp.json()) as {
    choices?: Array<{ message?: { content?: string | null }; finish_reason?: string }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const choice = data.choices?.[0];
  let valid = false;
  let problems = '';
  const content = choice?.message?.content;
  if (content) {
    try {
      const action = JSON.parse(content) as SeatAction;
      const p = validateSeatAction(action);
      valid = p.length === 0;
      problems = p.join('; ');
    } catch (err) {
      problems = `unparseable: ${String(err).slice(0, 120)}`;
    }
  } else {
    problems = 'empty content';
  }
  return {
    outputTokens: data.usage?.completion_tokens ?? 0,
    inputTokens: data.usage?.prompt_tokens ?? 0,
    ms,
    finish: String(choice?.finish_reason),
    valid,
    problems,
  };
}

async function runArm(arm: Arm, fx: Fixture): Promise<Measurement> {
  const sep = arm.spec.indexOf(':');
  const provider = arm.spec.slice(0, sep);
  const model = arm.spec.slice(sep + 1);
  if (provider === 'anthropic') return callAnthropic(model, arm.effort, fx.obs);
  if (provider === 'zai')
    return callCompat(model, arm.effort, fx.obs, 'https://api.z.ai/api/paas/v4', 'ZAI_API_KEY', arm.disableThinking);
  if (provider === 'openai')
    return callCompat(model, arm.effort, fx.obs, 'https://api.openai.com/v1', 'OPENAI_API_KEY', false, {
      mode: 'json_schema',
      tokenParam: 'max_completion_tokens',
    });
  if (provider === 'opencode')
    return callCompat(model, arm.effort, fx.obs, 'https://opencode.ai/zen/v1', 'OPENCODE_API_KEY');
  throw new Error(`unknown provider "${provider}"`);
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const chroniclePath = arg('chronicle', 'runs/t2-full/chronicle-rot0.json');
  const scenarioPath = arg('scenario', 'scenarios/kilnspire-ledger-424242-v2.json');
  const outDir = arg('outDir', 'runs/effort-probe');
  const only = arg('arms', '');

  const ch = JSON.parse(fs.readFileSync(chroniclePath, 'utf8')) as Chronicle;
  const scenario = JSON.parse(fs.readFileSync(scenarioPath, 'utf8')) as Scenario;

  // Kilnspire is the Deep Gallery Collapse target (t52, six ticks of private
  // warning). t44 is an ordinary tick with a mature ledger and no personal
  // crisis; t47 holds the private forewarning with the shock five ticks out.
  const fixtures: Fixture[] = [
    {
      label: 'quiet',
      provenance: `${path.basename(chroniclePath)} c2 (Kilnspire) t44`,
      obs: buildObservation(ch, scenario, 'c2', 44),
    },
    {
      label: 'crisis',
      provenance: `${path.basename(chroniclePath)} c2 (Kilnspire) t47`,
      obs: buildObservation(ch, scenario, 'c2', 47),
    },
  ];

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'observations.json'), JSON.stringify(fixtures, null, 2));

  for (const fx of fixtures) {
    const msg = observationToMessage(fx.obs);
    console.log(
      `${fx.label.padEnd(6)} ${fx.provenance} — ${msg.length} chars, journal ${fx.obs.memory.length}, ` +
        `inbox ${fx.obs.inbox.length}, agreements ${fx.obs.ledger.agreements.length}, ` +
        `offers ${fx.obs.ledger.incomingOffers.length}in/${fx.obs.ledger.outgoingOffers.length}out, ` +
        `forewarnings ${fx.obs.you.forewarnings.length}`,
    );
  }

  if (flag('dry-run')) {
    console.log(`\n--- ${fixtures[1].label} observation ---\n${observationToMessage(fixtures[1].obs)}`);
    return;
  }

  const repeats = Number(arg('repeats', '1'));
  const onlyEfforts = arg('efforts', '');
  const wanted = onlyEfforts ? new Set(onlyEfforts.split(',')) : null;
  const specs = only ? new Set(only.split(',')) : null;
  const arms = ARMS.filter((a) => (!specs || specs.has(a.spec)) && (!wanted || wanted.has(a.effort)));
  console.log(
    `\n${arms.length} arms x ${fixtures.length} observations x ${repeats} = ${arms.length * fixtures.length * repeats} calls\n`,
  );

  const results: Result[] = [];
  for (const arm of arms) {
    for (const fx of fixtures) {
      for (let rep = 0; rep < repeats; rep++) {
        const label = `${arm.spec} effort=${arm.effort} ${fx.label}${repeats > 1 ? ` #${rep + 1}` : ''}`;
        try {
          const r = await runArm(arm, fx);
          results.push({ ...r, spec: arm.spec, effort: arm.effort, fixture: fx.label, rep });
          console.log(
            `${label.padEnd(52)} ${String(r.outputTokens).padStart(6)} out  ${String(Math.round(r.ms / 1000)).padStart(4)}s  ` +
              `${r.finish.padEnd(12)} ${r.valid ? 'valid' : `INVALID ${r.problems.slice(0, 80)}`}`,
          );
        } catch (err) {
          console.log(`${label.padEnd(52)} FAILED ${String(err).slice(0, 160)}`);
        }
        fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(results, null, 2));
      }
    }
  }

  // With repeats, a single number per cell hides the thing the repeats were run
  // to expose. Print the spread so a between-setting difference can be read
  // against the within-setting one instead of taken on faith.
  console.log(`\n=== output tokens per call ===`);
  const cells = [...new Set(results.map((r) => `${r.spec}|${r.effort}|${r.fixture}`))];
  const header = repeats > 1 ? 'n   mean     sd    min    max  invalid' : 'tokens';
  console.log(`${'seat'.padEnd(28)} ${'effort'.padEnd(10)} ${'tick'.padEnd(7)} ${header}`);
  for (const key of cells) {
    const [spec, effort, fixture] = key.split('|');
    const xs = results.filter((r) => r.spec === spec && r.effort === effort && r.fixture === fixture);
    const n = xs.length;
    const toks = xs.map((r) => r.outputTokens);
    const mean = toks.reduce((a, b) => a + b, 0) / n;
    const sd = n > 1 ? Math.sqrt(toks.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
    const bad = xs.filter((r) => !r.valid).length;
    const stats =
      repeats > 1
        ? `${String(n).padStart(2)}  ${mean.toFixed(0).padStart(6)} ${sd.toFixed(0).padStart(6)} ${String(Math.min(...toks)).padStart(6)} ${String(Math.max(...toks)).padStart(6)}  ${bad}`
        : `${toks[0]}${bad ? ' INVALID' : ''}`;
    console.log(`${spec.padEnd(28)} ${effort.padEnd(10)} ${fixture.padEnd(7)} ${stats}`);
  }
  console.log(`\nraw: ${path.join(outDir, 'results.json')}`);
}

await main();
