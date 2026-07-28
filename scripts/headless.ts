// Headless batch runner: verifies collapse timing and trade viability
// without a browser. `npm run headless`
import { defaultConfig } from '../src/engine/config';
import { Simulation } from '../src/engine/sim';
import { ScriptedSeat } from '../src/engine/seats/scripted';
import { RNG } from '../src/engine/rng';
import type { Seat } from '../src/engine/types';

async function run(label: string, opts: { trade: boolean; opportunists: number; ticks: number; seed?: number }): Promise<void> {
  const cfg = defaultConfig(opts.seed ?? 20260725);
  cfg.tradeEnabled = opts.trade;
  cfg.opportunistCount = opts.opportunists;
  const sim = new Simulation(cfg);
  const rng = new RNG(cfg.seed ^ 0x9e3779b9);
  const seats = new Map<string, Seat>(sim.cities.map((c) => [c.id, new ScriptedSeat(c.id, c.personality, rng)]));

  console.log(`\n=== ${label} (seed ${cfg.seed}) ===`);
  console.log(
    'cities: ' +
      sim.cities
        .map((c) => `${c.name}[${c.produces.map((r) => r[0].toUpperCase()).join('')}${c.personality === 'opportunist' ? ' opp' : ''}]`)
        .join('  '),
  );
  for (let t = 1; t <= opts.ticks; t++) {
    await sim.step(seats);
    if (t % 10 === 0 || sim.aliveCities().length === 0) {
      console.log(
        `t${String(t).padStart(3)}  ` +
          sim.cities
            .map((c) => `${c.name.slice(0, 5).padEnd(5)}:${c.status === 'ruins' ? 'DEAD' : String(Math.round(c.population)).padStart(4)}`)
            .join('  '),
      );
      if (sim.aliveCities().length === 0) break;
    }
  }
  const collapses = sim.events.filter((e) => e.kind === 'collapse');
  console.log(collapses.length ? 'collapses: ' + collapses.map((e) => `${e.text} @t${e.tick}`).join(' | ') : 'no collapses');
  const pacts = sim.events.filter((e) => e.kind === 'pact').length;
  const defections = sim.events.filter((e) => e.kind === 'defection').length;
  console.log(`pacts: ${pacts}, defections: ${defections}`);
}

await run('AUTARKY — no trade (collapse-timing check)', { trade: false, opportunists: 0, ticks: 40 });
await run('TRADE — all honest', { trade: true, opportunists: 0, ticks: 120 });
await run('TRADE — one opportunist', { trade: true, opportunists: 1, ticks: 120 });
