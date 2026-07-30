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
import fs from 'node:fs';
import path from 'node:path';
import { Simulation } from '../src/engine/sim';
import { configForScenario, type Scenario } from '../src/engine/scenario';
import { ScriptedSeat } from '../src/engine/seats/scripted';
import { RNG } from '../src/engine/rng';
import type { Seat } from '../src/engine/types';

const dir = 'scenarios';
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
let failures = 0;

for (const f of files) {
  const scenario = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as Scenario;
  const cfg = configForScenario(scenario);
  cfg.opportunistCount = 0;
  const sim = new Simulation(cfg, scenario);
  const rng = new RNG(cfg.seed ^ 0x9e3779b9);
  const seats = new Map<string, Seat>(sim.cities.map((c) => [c.id, new ScriptedSeat(c.id, 'honest', rng)]));

  // Same horizon genmap uses: past the last shock, minimum 60 ticks.
  const lastShockEnd = (scenario.shocks ?? []).reduce((a, s) => Math.max(a, s.startTick + s.duration), 0);
  const ticks = Math.max(60, lastShockEnd + 10);
  for (let t = 1; t <= ticks; t++) await sim.step(seats);

  const collapsed = sim.cities.filter((c) => c.status === 'ruins');
  const state = sim.cities.map((c) => `${c.name} ${c.status === 'ruins' ? 'RUINS' : Math.round(c.population)}`).join('  ');
  console.log(`${f}  (${ticks} ticks, honest scripted seats)`);
  console.log(`  ${state}`);
  const built = sim.cities.filter((c) => c.ceilingBonus > 0);
  console.log(`  ${collapsed.length === 0 ? 'PASS' : 'FAIL'}  survivable by honest cooperators`);
  // Scripted seats never build (ADR-004). If any ceiling moved, a scripted seat
  // has started building and every gate result in the repo is now suspect.
  console.log(`  ${built.length === 0 ? 'PASS' : 'FAIL'}  scripted seats did not build`);
  if (collapsed.length) failures++;
  if (built.length) failures++;
}

console.log(failures === 0 ? '\nAll scenarios certified.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
