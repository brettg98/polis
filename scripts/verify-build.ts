// Acceptance cases for the build phase (ADR-004, issue #4). `npm run verify:build`
//
// These pin the one decision the ADR spends the most words on: build spends
// AFTER deliveries move. Get the order backwards and both cases still run, the
// numbers still look plausible, and the mechanic silently stops measuring what
// it exists to measure — a city could spend its way out of a betrayal record.
//
// No models, no keys, fully deterministic.
import { defaultConfig } from '../src/engine/config';
import { Simulation } from '../src/engine/sim';
import type { Seat, SeatAction, SeatObservation } from '../src/engine/types';

// A seat that returns exactly what the case calls for on a given tick.
class TestSeat implements Seat {
  readonly label = 'test';
  constructor(
    readonly cityId: string,
    private readonly script: (obs: SeatObservation) => SeatAction,
  ) {}
  async getAction(obs: SeatObservation): Promise<SeatAction> {
    return this.script(obs);
  }
}

let failures = 0;
function check(label: string, actual: number | boolean, expected: number | boolean, tolerance = 0.001): void {
  const ok =
    typeof actual === 'boolean' || typeof expected === 'boolean'
      ? actual === expected
      : Math.abs(actual - expected) <= tolerance;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: got ${typeof actual === 'number' ? actual.toFixed(2) : actual}, want ${typeof expected === 'number' ? expected.toFixed(2) : expected}`);
  if (!ok) failures++;
}

// Stand up two adjacent cities with an active agreement: c1 ships `due`
// materials per tick to c2. Returns once the agreement is live and it is c1's
// turn to submit the delivery that lands next tick.
async function arena(due: number): Promise<{ sim: Simulation; agreementId: string }> {
  const cfg = defaultConfig(424242);
  cfg.numCities = 2;
  const sim = new Simulation(cfg);
  const [a, b] = sim.cities;
  // Put them next to each other so transport efficiency is 1.0 and the
  // arithmetic below is about the phase order, not about distance.
  b.site = { ...a.site };

  let agreementId = '';
  const seats = new Map<string, Seat>([
    [
      a.id,
      new TestSeat(a.id, (obs) =>
        obs.tick === 1
          ? {
              offers: [
                { to: b.id, give: { resource: 'materials', qty: due }, receive: { resource: 'food', qty: 1 }, duration: 40 },
              ],
            }
          : {},
      ),
    ],
    [
      b.id,
      new TestSeat(b.id, (obs) => ({
        responses: obs.ledger.incomingOffers.map((o) => ({ offerId: o.id, decision: 'accept' as const })),
      })),
    ],
  ]);

  // t1 offer, t2 accept, agreement becomes active at t4.
  for (let t = 1; t <= 3; t++) await sim.step(seats);
  for (const ag of sim.agreements.values()) agreementId = ag.id;
  if (!agreementId) throw new Error('setup failed: no agreement was formed');
  return { sim, agreementId };
}

// Run one case: on the next tick c1 submits `ship` against the agreement and
// asks to build `build`, with its materials forced to `stock` first.
async function runCase(opts: {
  label: string;
  due: number;
  stock: number;
  ship: number;
  build: number;
  expect: { delivered: number; banked: number; defection: boolean };
}): Promise<void> {
  console.log(`\n${opts.label}`);
  const { sim, agreementId } = await arena(opts.due);
  const [a, b] = sim.cities;

  const seats = new Map<string, Seat>([
    [a.id, new TestSeat(a.id, () => ({
      deliveries: opts.ship > 0 ? [{ agreementId, qty: opts.ship }] : [],
      build: opts.build,
    }))],
    [b.id, new TestSeat(b.id, () => ({}))],
  ]);

  // Queue the delivery and the build request.
  await sim.step(seats);

  // Force the warehouse to the exact figure the case is about, then let the
  // next resolve move goods. Deliveries land first, build spends second.
  a.stockpiles.materials = opts.stock;

  // Measure delivery from the agreement's own books, not from the partner's
  // warehouse — the partner also produces and consumes during the same resolve.
  const ag = sim.agreements.get(agreementId)!;
  const deliveredBefore = ag.fulfillment[a.id].delivered;
  // The agreement is two-sided and b never ships its side, so b defects every
  // tick. Only a's record is under test here.
  const defectionsBefore = sim.events.filter((e) => e.kind === 'defection' && e.actor === a.id).length;

  const idle = new Map<string, Seat>([
    [a.id, new TestSeat(a.id, () => ({}))],
    [b.id, new TestSeat(b.id, () => ({}))],
  ]);
  await sim.step(idle);

  const defected = sim.events.filter((e) => e.kind === 'defection' && e.actor === a.id).length > defectionsBefore;
  check('delivered to partner', ag.fulfillment[a.id].delivered - deliveredBefore, opts.expect.delivered, 0.5);
  check('banked toward ceiling', a.buildProgress, opts.expect.banked, 0.5);
  check('defection recorded', defected, opts.expect.defection);
}

console.log('=== Build phase acceptance (ADR-004) ===');

// Case 1 — overreach. Owes 10, holds 35, asks to build 30.
// Deliveries move first, so the partner is paid in full and the city's own
// build absorbs the shortfall: 35 - 10 = 25 banked, not the 30 requested.
await runCase({
  label: 'Case 1: overreach shorts your own build, never your partner',
  due: 10,
  stock: 35,
  ship: 10,
  build: 30,
  expect: { delivered: 10, banked: 25, defection: false },
});

// Case 2 — betrayal. Owes 10, holds 40, ships nothing, asks to build 30.
// The defection check runs before the spend, so the city is still holding 40
// against a 30 threshold (due * 3) when it is judged. Betrayal is recorded,
// and the build proceeds afterwards.
await runCase({
  label: 'Case 2: shipping nothing while able is still a betrayal',
  due: 10,
  stock: 40,
  ship: 0,
  build: 30,
  expect: { delivered: 0, banked: 30, defection: true },
});

// Case 3 — step costs rise. A single large deposit completes several steps,
// each one dearer than the last: 50 + 75 + 100 + 125 + 150 = 500 exactly.
// If stepsCompleted were miscounted the costs would stay flat and 500 would
// buy ten steps instead of five, so this is the guard on runaway expansion.
{
  console.log('\nCase 3: each step costs more than the last');
  const { sim, agreementId } = await arena(10);
  const [a, b] = sim.cities;
  const seats = new Map<string, Seat>([
    [a.id, new TestSeat(a.id, () => ({ deliveries: [{ agreementId, qty: 10 }], build: 500 }))],
    [b.id, new TestSeat(b.id, () => ({}))],
  ]);
  await sim.step(seats);
  a.stockpiles.materials = 510; // 10 ships, 500 reaches the build phase
  const idle = new Map<string, Seat>([
    [a.id, new TestSeat(a.id, () => ({}))],
    [b.id, new TestSeat(b.id, () => ({}))],
  ]);
  await sim.step(idle);

  check('steps completed', a.ceilingBonus / sim.config.build.ceilingPerStep, 5);
  check('ceiling', sim.ceilingOf(a), 275);
  check('nothing left banked', a.buildProgress, 0);
  check('next step now costs', sim.nextStepCost(a), 175);
  check('build events emitted', sim.events.filter((e) => e.kind === 'build').length, 5);
}

console.log(failures === 0 ? '\nAll cases passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
