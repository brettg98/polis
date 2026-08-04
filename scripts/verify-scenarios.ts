// Re-certifies every committed scenario against the sanity gate (ADR-003):
// honest cooperators must survive the whole shock schedule. `npm run verify:scenarios`
//
// genmap runs this gate once, when a world is authored, and then the result is
// frozen in the committed file. Any change to the economy — ceiling maths,
// tuning constants, growth rules — can silently invalidate it. This reproduces
// the gate on demand so the certification can be re-checked without an API key
// and without regenerating the world.
//
// Output is deterministic, so diffing it across a branch is the check that an
// engine change left honest play untouched.
//
// MANY DRAWS, NOT ONE (#30). Until 2026-08-04 this ran a single seat-RNG draw
// and printed "PASS survivable by honest cooperators". That claim was much
// broader than what was checked: kilnspire-ledger-424242-v2 kills a city in
// most draws, and the one draw the gate happened to test is among the
// survivors. The pass/fail contract is deliberately unchanged — the certified
// draw is still what gates — but the survival rate is now reported alongside
// it, so the output stops asserting something it has not established. Choosing
// a rate to fail on is a separate decision and needs a number from evidence.
import fs from 'node:fs';
import path from 'node:path';
import { Simulation } from '../src/engine/sim';
import { configForScenario, type Scenario } from '../src/engine/scenario';
import { ScriptedSeat } from '../src/engine/seats/scripted';
import { RNG } from '../src/engine/rng';
import type { Seat } from '../src/engine/types';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const dir = 'scenarios';
const draws = Math.max(1, Number(arg('draws', '200')));
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
let failures = 0;

// Draw 0 reproduces the seat RNG genmap and every earlier run of this script
// used, so it stays the certified draw and its output is unchanged. Later draws
// offset by a fixed stride, which keeps the whole sweep deterministic.
function seatRng(seed: number, draw: number): RNG {
  return new RNG((seed ^ 0x9e3779b9) + draw * 7919);
}

for (const f of files) {
  const scenario = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as Scenario;
  // Same horizon genmap uses: past the last shock, minimum 60 ticks.
  const lastShockEnd = (scenario.shocks ?? []).reduce((a, s) => Math.max(a, s.startTick + s.duration), 0);
  const ticks = Math.max(60, lastShockEnd + 10);

  let survivedDraws = 0;
  let certifiedState = '';
  let certifiedCollapsed = 0;
  let certifiedBuilt = 0;
  const deathsByCity = new Map<string, number>();
  const collapseTickSum = new Map<string, number>();

  for (let d = 0; d < draws; d++) {
    const cfg = configForScenario(scenario);
    cfg.opportunistCount = 0;
    const sim = new Simulation(cfg, scenario);
    const rng = seatRng(cfg.seed, d);
    const seats = new Map<string, Seat>(sim.cities.map((c) => [c.id, new ScriptedSeat(c.id, 'honest', rng)]));
    for (let t = 1; t <= ticks; t++) await sim.step(seats);

    const collapsed = sim.cities.filter((c) => c.status === 'ruins');
    if (collapsed.length === 0) survivedDraws++;
    for (const c of collapsed) {
      deathsByCity.set(c.name, (deathsByCity.get(c.name) ?? 0) + 1);
      collapseTickSum.set(c.name, (collapseTickSum.get(c.name) ?? 0) + (c.collapsedTick ?? 0));
    }
    if (d === 0) {
      certifiedState = sim.cities
        .map((c) => `${c.name} ${c.status === 'ruins' ? 'RUINS' : Math.round(c.population)}`)
        .join('  ');
      certifiedCollapsed = collapsed.length;
      // Scripted seats never build (ADR-004). If any ceiling moved, a scripted
      // seat has started building and every gate result in the repo is suspect.
      certifiedBuilt = sim.cities.filter((c) => c.ceilingBonus > 0).length;
    }
  }

  const pct = ((survivedDraws / draws) * 100).toFixed(1);
  console.log(`${f}  (${ticks} ticks, ${draws} draw${draws === 1 ? '' : 's'}, honest scripted seats)`);
  console.log(`  certified draw: ${certifiedState}`);
  console.log(`  survives ${survivedDraws}/${draws} draws (${pct}%)`);
  if (deathsByCity.size) {
    const detail = [...deathsByCity]
      .sort((a, b) => b[1] - a[1])
      .map(([name, n]) => `${name} ${n} (mean t${Math.round((collapseTickSum.get(name) ?? 0) / n)})`)
      .join(', ');
    console.log(`  cities lost across draws: ${detail}`);
  }
  console.log(`  ${certifiedCollapsed === 0 ? 'PASS' : 'FAIL'}  the certified draw survives`);
  console.log(`  ${certifiedBuilt === 0 ? 'PASS' : 'FAIL'}  scripted seats did not build`);
  if (certifiedCollapsed) failures++;
  if (certifiedBuilt) failures++;
}

console.log(failures === 0 ? '\nAll scenarios certified on the certified draw.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
