# POLIS design

## Design decisions

- **Seats, not models.** The engine knows only the `Seat` interface
  (`src/engine/types.ts`). Model assignment is a lineup concern; all-same-model
  is the self-play baseline, mixed lineups are the tournament.
- **Deals are promises.** An agreement records what each side ships per tick;
  delivery is a separate per-tick action. Defection is mechanically possible
  and only socially punished — reputation, retaliation, and forgiveness are
  entirely up to the seats.
- **Fog of war is server-side.** Observations are constructed per seat. Terrain
  (and therefore production capability) is public; stockpiles, exact
  population, and third-party agreements are private. Never hand a seat full
  state and ask it to role-play ignorance.
- **Journals, not transcripts.** A seat's memory is its own capped journal fed
  back verbatim next tick. Keeps per-call cost constant across a run and is
  itself telemetry (what did each model choose to remember?).
- **Seeded determinism.** Same seed = same terrain, cities, and economy. Model
  calls are the only nondeterminism; log everything for replay.
- **Simultaneous commits.** All seats act blind each tick; sequential turns
  would make seat order an advantage and pollute cross-model comparison.

## Architecture

- `src/engine/` — deterministic sim, zero rendering deps, runs headless.
  Tick order: resolve → observe → act → apply (see `sim.ts` header comment).
- `src/engine/seats/` — seat implementations. Scripted heuristics now; LLM
  seats are drop-ins behind the same interface.
- `src/render/` — Three.js scene + DOM HUD. Never imported by the engine.
- `scripts/headless.ts` — batch runs and verification. The tournament runner
  will live here.

## Tuning knobs (`src/engine/config.ts`)

- **Collapse buffer** ≈ 15 ticks from full stockpile to ruins for a city
  missing one resource: `startStockpileTicks` (storage) +
  `starvationDecline` (decay speed). How much time pressure seats feel before
  turning on each other may be the most interesting variable in the sim.
- **Production slack**: `productionPerCapita` (0.22). Surplus per produced
  resource ≈ 2.2× one city's consumption, so a world where a resource has only
  two producers is viable but tight. Lower toward 0.20 for a knife-edge
  economy where defection turns lethal.
- Verified behavior at defaults (seed 20260725): autarky collapses all cities
  at tick 16; honest trade sustains indefinitely; one opportunist is contained
  by tit-for-tat.

## Scenarios (Fable-authored worlds)

`scenarios/*.json` are committed, reproducible world definitions: terrain
still derives from the seed; the scenario fixes city sites, production
assignments, names, lore, and economy slack. Generate with
`npm run genmap -- --seed N` (Fable, via `ANTHROPIC_MAPGEN_API_KEY`; validated,
snap-corrected, one repair round, then sanity-simmed with honest scripted
seats for 60 ticks before writing). Load with `--scenario <file>` on smoke and
the tournament runner. Fable is never called at run time. Known gap: the
browser build doesn't load scenario files yet.

## Shocks & distance (ADR-003)

Scenarios may schedule **shocks**: named production multipliers (city/world ×
resource/all × tick window), forecast or surprise, all public in
`world.shocks` — plus optional **private forewarnings** to the target city
(`you.forewarnings`), which is the deception instrument. Rails and the
survivable-by-cooperators sanity gate live in `scenario.ts` / genmap.
**Distance**: deliveries lose `0.25%/cell` in transit (floor 60% efficiency,
constants in `config.trade`); quantities and fulfillment are origin-measured,
so transit loss is never defection; per-counterparty efficiency is in every
observation.

## The Chronicle (ADR-002)

Per rotation, the runner writes a Chronicle: complete post-hoc record
(events, full message transcript, per-tick journals and stockpile/population
series, offer/agreement lifecycles). The tournament runner also emits the
Chronicle Viewer — one self-contained HTML file per tournament (front page:
results + rotation cards; per rotation: event timeline, journal scrubber,
diplomatic cables, population chart, canvas top-down map). Regenerate the
HTML from existing chronicles with `npm run chronicle -- <tournament-dir>`.
Terms in CONTEXT.md; rationale in ADR-002.

## Prior art

**M.U.L.E.** (Ozark Softscape, 1983; design by Danielle Bunten Berry). The
lineage POLIS descends from, consciously or not: four players colonize one
planet, every player produces some resources and depends on the market for
the rest, food shortages cost you action time, smithore shortages choke
everyone's expansion, and the colony is scored collectively — a monopolist
can win the wealth race while the colony fails. Player-driven price
discovery (the walk-your-avatar auction), collusion, and engineered
shortages were all core play. POLIS swaps the couch for API seats and the
auction for bilateral offers, and adds the one thing M.U.L.E. never had:
deals as promises, so betrayal is a mechanic instead of a table-manners
violation. Worth a nod in the writeup.

## Deferred (fits the seat model later, don't build for v1)

Raids/military, espionage, resource decay, migration, negotiate subrounds
beyond R=1 (the message plumbing exists; scripted seats barely use it).
Viewer-side: replay animation on the 3D map, trust-over-time graph,
agreement Gantt, full-text search, cross-tournament comparison.
Economy realism (considered 2026-07-25, deferred): resource-differentiated
spoilage (food decays — kills hoard-and-coast; re-tuning risk near the
tournament) and unrest-with-teeth (production penalty — punishes losers
harder without creating decisions).

Tournament-2 candidates (considered 2026-07-26, deferred — mid-tournament
changes would invalidate cross-rotation comparability):

- **Spot market** (the M.U.L.E. auction, translated). Per-resource sealed
  bid/ask each tick, engine clears at a uniform price, instant settlement.
  Kept *alongside* pacts, not replacing them: spot is trustless but priced
  by scarcity, pacts offer better terms but require trust. The measurable
  payoff is the spread between spot price and pact terms — the price of
  trust — plus observable flight-to-spot after betrayals, and whether an
  embargoing city uses the market to cover its own needs while starving a
  partner. Costs: clearing mechanism to design/tune, bigger observations,
  more tokens per tick, harder prompt.
- **Expansion** (materials-funded growth). Spend materials to raise the
  population ceiling, rising cost per step. Fixes an observed measurement
  problem: rotation 1 ended with three cities tied at cap 150 — the score
  saturates and the chart loses resolution exactly where it matters.
  **Designed and locked in ADR-004** (grilled 2026-07-29); not yet built.
  Build is its own turn phase resolving after deliveries, progress
  accumulates, the ceiling gets a separate bonus term, and prices are set
  against the kilnspire-ledger materials economy. Read ADR-004 before
  implementing — several of the choices are non-obvious.
- Sequencing if both: expansion first (it improves the headline chart),
  market second (it gives expansion-driven materials demand a place to
  clear).

Tournament-3 candidate (considered 2026-07-26, deferred): **weapons, as a
controlled comparison — never blended in.** The design is the experiment:
run the SAME scenario and SAME lineup twice, weapons off (the existing
trade-only game, which becomes the control condition) and weapons on, and
publish the *difference*. The finding is how much cooperation evaporates
when coercion is available, and which model's behavior changes most.

- What it measures that nothing else can: coercion vs persuasion choice
  (raid when rich and opportunistic, or only when starving?), refusal to
  order militarily optimal attacks (expected to differ by vendor), threat
  credibility (follow-through rate on "pay tribute or else"), danegeld
  payment rates, and honor rates on two new promise classes —
  arms-control pacts and mutual-defense pacts — measured exactly like
  delivery reliability.
- Mechanics fall out of existing systems: weapons are a materials+energy
  sink (with expansion, materials become contested three ways:
  consumption, growth, arms); transport efficiency gives power-projection
  falloff over distance; fog of war makes arsenals partially observable,
  creating the security dilemma for free.
- Tuning constraint that protects the instrument: war must be
  negative-sum (attacker's haul < combined destruction, both sides lose
  population and materiel) so raiding is an informative failure, not
  optimal play. If raiding is efficient the trade economy dies and the
  benchmark becomes a wargame. Every scenario sanity gate re-validates.
- Grill before building: combat resolution, arsenal observability/intel,
  raid targeting (stockpiles vs production vs population), alliance
  mechanics, and whether refusals need a schema-level "decline" action so
  they're recorded as data rather than lost as invalid output.
