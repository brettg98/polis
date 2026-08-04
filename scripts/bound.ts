// Post-run half of the ADR-006 bound check.
//
// ADR-006 replaced "identical reasoning effort" with a bound on measured output
// tokens, and requires it checked before a run (the probe, scripts/effort-probe.ts)
// and again from the call logs afterwards. This is the afterwards half.
//
//   npm run bound -- --dir runs/t3-testrun
//
// NOT named verify:* on purpose. Those are pass/fail gates that stop a build.
// This one reports: per ADR-006 the bound gates which settings may be used, not
// which results may be published, so a breach here is a disclosure obligation
// rather than a reason to discard a run. Exit codes follow from that —
//
//   0  the run was measured (whether or not it breached)
//   1  the run could not be measured, so no claim can be made either way
//
// which is the distinction that matters. A silent false pass is the failure
// mode worth engineering against: it would let a run be published under a
// fairness claim nothing actually checked.
import fs from 'node:fs';
import path from 'node:path';
import { outputTokensFrom } from '../src/llm/chatCompletionsSeat';

// ADR-006, 2026-08-02 amendment. Output per call settles by roughly t20-40 and
// is flat or slightly declining after, so the opening is a transient rather than
// the steady state and is excluded. Measured across tournament 2's four
// rotations of 100 ticks: Opus -16%, Sonnet -2%, Terra -9%, GLM -7% from the
// first window to the last.
const DISCARD_THROUGH_TICK = 20;
const RATIO_LIMIT = 3;
// Below this many post-transient calls a seat is measuring noise. A 25-tick run
// leaves five, which is not a measurement — the guard exists because the obvious
// mistake is to certify a short test run and believe it.
const MIN_CALLS_PER_SEAT = 20;
// Reports reasoning_tokens: 0 for the GPT route while billing for them, so a
// seat here looks *more* compliant the more it actually thinks. The bound is
// defined on output tokens; on this route that quantity is under-reported by
// construction and no effort value fixes it.
const UNMEASURABLE_PROVIDERS = new Set(['opencode']);

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const dir = arg('dir', '');
if (!dir) {
  console.error('usage: npm run bound -- --dir runs/<name>');
  process.exit(1);
}
if (!fs.existsSync(dir)) {
  console.error(`no such run dir: ${dir}`);
  process.exit(1);
}

// cityId -> spec, per rotation. The log filename carries rotation and cityId;
// only the run record knows which provider was behind them, and the provider is
// what decides whether the numbers mean anything.
const assignments = new Map<string, string>(); // "rot0|c1" -> spec
for (const f of fs.readdirSync(dir).filter((n) => /^run-rot\d+\.json$/.test(n))) {
  const rot = f.match(/\d+/)![0];
  const rec = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as { assignment?: Record<string, string> };
  for (const [cityId, spec] of Object.entries(rec.assignment ?? {})) assignments.set(`rot${rot}|${cityId}`, spec);
}
if (assignments.size === 0) {
  console.error(`no run-rot*.json in ${dir}; cannot tell which provider served which seat`);
  process.exit(1);
}

interface Call {
  tick: number;
  out: number;
}
const bySpec = new Map<string, Call[]>();
for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl'))) {
  const m = f.match(/^(rot\d+)-([^-]+)-/);
  if (!m) continue;
  const spec = assignments.get(`${m[1]}|${m[2]}`);
  if (!spec) continue;
  for (const line of fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n')) {
    if (!line) continue;
    const j = JSON.parse(line) as {
      tick?: number;
      usage?: { output_tokens?: number; completion_tokens?: number; total_tokens?: number; prompt_tokens?: number };
    };
    if (!j.usage || typeof j.tick !== 'number') continue;
    // Derived rather than read from one field, because the field is not
    // comparable across providers (#33). An earlier version of this line took
    // output_tokens ?? completion_tokens and said in a comment that both include
    // reasoning — true of the four routes it had been run against, false of
    // Google's OpenAI-compat endpoint, which leaves reasoning out of
    // completion_tokens entirely. See outputTokensFrom for the measurements.
    const out = outputTokensFrom(j.usage);
    if (out > 0) (bySpec.get(spec) ?? bySpec.set(spec, []).get(spec)!).push({ tick: j.tick, out });
  }
}
if (bySpec.size === 0) {
  console.error(`no seat call logs with usage in ${dir}`);
  process.exit(1);
}

const mean = (a: number[]): number => a.reduce((x, y) => x + y, 0) / a.length;

interface SeatStat {
  spec: string;
  kept: number[];
  windows: Array<{ label: string; mean: number; n: number }>;
}
const stats: SeatStat[] = [];
for (const [spec, calls] of [...bySpec.entries()].sort()) {
  const kept = calls.filter((c) => c.tick > DISCARD_THROUGH_TICK).map((c) => c.out);
  const maxTick = Math.max(...calls.map((c) => c.tick));
  const windows: Array<{ label: string; mean: number; n: number }> = [];
  for (let lo = 1; lo <= maxTick; lo += 20) {
    const hi = lo + 19;
    const xs = calls.filter((c) => c.tick >= lo && c.tick <= hi).map((c) => c.out);
    if (xs.length) windows.push({ label: `t${lo}-${Math.min(hi, maxTick)}`, mean: mean(xs), n: xs.length });
  }
  stats.push({ spec, kept, windows });
}

console.log(`ADR-006 bound — ${dir}`);
console.log(`discarding t1-${DISCARD_THROUGH_TICK} (opening transient), limit ${RATIO_LIMIT}x\n`);

const widest = Math.max(...stats[0].windows.map((w) => w.label.length), 8);
console.log(`${'seat'.padEnd(30)} ${'n'.padStart(4)} ${'mean'.padStart(7)}   ${stats[0].windows.map((w) => w.label.padStart(widest)).join(' ')}`);
for (const s of stats) {
  const m = s.kept.length ? mean(s.kept).toFixed(0) : '—';
  console.log(
    `${s.spec.padEnd(30)} ${String(s.kept.length).padStart(4)} ${m.padStart(7)}   ` +
      s.windows.map((w) => w.mean.toFixed(0).padStart(widest)).join(' '),
  );
}

// Reasons the run cannot be certified. Collected rather than short-circuited so
// one command reports every blocker instead of one per invocation.
const blockers: string[] = [];
for (const s of stats) {
  const provider = s.spec.slice(0, s.spec.indexOf(':'));
  if (UNMEASURABLE_PROVIDERS.has(provider)) {
    blockers.push(
      `${s.spec} runs on the ${provider} route, which reports reasoning_tokens: 0 while billing for them. ` +
        `Its output tokens are under-reported by construction, so it would appear more compliant the more it thought.`,
    );
  } else if (s.kept.length < MIN_CALLS_PER_SEAT) {
    blockers.push(
      `${s.spec} has ${s.kept.length} calls past t${DISCARD_THROUGH_TICK}, below the ${MIN_CALLS_PER_SEAT} needed. ` +
        `A short run measures the opening transient, not the steady state.`,
    );
  }
}

if (blockers.length) {
  console.log('\nNOT MEASURABLE — no claim can be made about this run:');
  for (const b of blockers) console.log(`  - ${b}`);
  process.exit(1);
}

const means = stats.map((s) => mean(s.kept));
const ratio = Math.max(...means) / Math.min(...means);
const hi = stats[means.indexOf(Math.max(...means))].spec;
const lo = stats[means.indexOf(Math.min(...means))].spec;
console.log(`\nwidest cross-seat ratio: ${ratio.toFixed(2)}x  (${hi} over ${lo})`);

if (ratio <= RATIO_LIMIT) {
  console.log(`within the ${RATIO_LIMIT}x bound.`);
} else {
  // Deliberately exit 0. ADR-006: the bound gates settings, not results — a
  // completed run that breaches is published as it came out with the deviation
  // disclosed, because re-running non-deterministic models yields a second
  // sample rather than a correction.
  console.log(`\nBREACHES the ${RATIO_LIMIT}x bound.`);
  console.log(`Per ADR-006 this run is still published — the bound gates which settings may be used,`);
  console.log(`not which results may appear. State the ratio next to the results, not in a footnote.`);
}
