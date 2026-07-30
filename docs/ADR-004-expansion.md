# ADR-004: Expansion

Date: 2026-07-29
Status: accepted

## Context

Tournament 1 ran into its own ceiling. Population is capped at
`startPopulation × maxGrowthFactor` = 150, and rotation 1 ended with three
cities tied there. Across all four rotations Kilnspire and Greyharrow finished
at the cap under every steward, so half the board carried no information and the
winning model's score was bounded by the ceiling rather than by its play.

There is a one-line fix for that: raise `maxGrowthFactor`. It was considered and
rejected as the goal. The chart problem is real, but a constant solves it, and
solving it that way adds nothing to measure.

What this ADR buys instead is a decision. Cities spend materials to raise their
own ceiling, and the point is to see how differently models handle that bet —
specifically how risk-averse each one is. Decided in a grill-me session,
2026-07-29.

## Decision

### 1. Build is its own turn phase, resolving after deliveries

The turn order becomes:

1. Shock announcements
2. Shipments promised last turn move — **defection check runs here**
3. **Build spends** (new)
4. Production
5. Consumption
6. Starvation or growth
7. Collapse check

Placement is the whole point. Deliveries and build draw from the same
stockpile, and a delivery is only a number written down until the next turn's
resolve. If build spent during the action phase, a city could empty its
warehouse and arrive at the next resolve genuinely poor — shipping nothing,
failing the "still holding 3× what was owed" test at `sim.ts:198`, and having
its broken promise recorded as misfortune rather than choice.

Resolving build after deliveries fixes that by ordering rather than by adding a
rule:

- a city that overreaches shorts **its own build**, never its partner
- a city that ships nothing while able is still recorded as defection, because
  the check has already run

Both outcomes are correct without the detector needing to know build exists.

### 2. Build progress accumulates; the seat must ask every turn

Materials go into a per-city build progress counter. The ceiling rises when
progress crosses the tier cost, and progress resets. A partial payment is just a
smaller deposit — no waste, no refund, no cliff for a city one material short.

The engine banks only what was asked for. There is no standing order, so
building stays a per-turn decision and a seat can stop halfway when a shock
lands, leaving progress banked indefinitely. Banked progress does not decay.

Accumulation also removes the affordability problem: the engine cannot reject an
unaffordable build when the action is submitted, because the seat decides a full
turn before the spend, with shipments, production, and shocks landing in
between. Spend what is there, credit what was spent — the same clamp deliveries
already use.

### 3. A separate bonus term, not a raised `startPopulation`

`ceiling = startPopulation × maxGrowthFactor + buildBonus`.

`startPopulation` anchors three separate quantities, and raising it moves all
three:

| quantity | formula | at `startPopulation` 100 |
|---|---|---|
| ceiling | `startPopulation × 1.5` | 150 |
| warehouse limit, per resource | `20 × 0.1 × startPopulation` | 200 |
| death threshold | `0.35 × startPopulation` | 35 |

Raising `startPopulation` to reach a ceiling of 175 would mean setting it to
116.7, so the number bought is not the number wanted, and it would also raise
the death threshold to 41. A city that invested in growth would die sooner, and
retroactively: expand at turn 20, take a shock at turn 60, collapse at a
population that would have survived otherwise. The death threshold is not in the
observation, so the model could not have priced that risk.

The separate bonus leaves the death threshold and warehouse limit exactly as
tournament 1 had them.

**Fragility is left to emerge rather than legislated.** The warehouse limit
stays at 200 while consumption rises with population, so a bigger city holds
proportionally less cushion: 20 turns of cover at population 100, 13 at 150, 11
at 175. That is the downside of expanding, it arrives through the economy rather
than through a constant we picked, and every number in it is already visible to
the seat. A rule making big cities explicitly weaker was considered and
rejected as a number we would be guessing at with no evidence the natural risk
is too small.

### 4. Ceiling public, banked progress private

The existing line is that what a city can **do** is public (terrain, therefore
production capability) and what it **has** is private (stockpiles, exact
population). Build splits along the same line:

- **ceiling is public.** It is built and physical. A neighbour can see that
  someone has made room to grow, and decide whether to help or squeeze them.
- **banked progress is private.** Materials in a yard are closer to a stockpile
  than to a building. A city can save quietly, and a neighbour only learns when
  it finishes.

This leaves announcing what you are building as a negotiating choice, which
lands in the message log where the Chronicle can show it.

The observation gains three fields a seat sees about itself: current ceiling,
banked progress, and the next tier cost. **The first of those is information
tournament-1 seats never had** — a city at 150 was never told 150 was the limit.

The neighbour size bands also have to extend upward. Today everything from 115
up reads as `large` (`sim.ts:286`), so a neighbour at 120 and one at 250 would
look identical, and a model cannot be nervous about a big neighbour it cannot
see. Bands become:

| population | reads as |
|---|---|
| under 70 | small |
| under 115 | medium |
| under 160 | large |
| 160 and over | huge |

160 sits just above the current hard ceiling of 150, so a neighbour reading
`huge` has provably built.

### 5. Prices

- first step: **50 materials**, +25 ceiling
- each step after costs **25 more**: 75, 100, 125
- ceiling gain stays +25 every step

Set against the `kilnspire-ledger` economy, where production is exactly double
consumption (0.2 against 0.1):

- Two cities make materials (Kilnspire, Greyharrow), two must buy them
  (Brinemark, Emberfall). A producer's spare materials equal exactly one city's
  appetite at every population, so supply and demand balance exactly — and
  transport loss then tips it negative. Landing 15 materials in Brinemark costs
  Kilnspire 18.8 shipped at 79.6% efficiency. The world runs about 6 materials a
  turn short of holding every city at 150.
- **So building cannot be funded from spare production. There isn't any.** It
  comes out of the warehouse, which is what makes it a risk decision, and
  `ticksUntilShortage` already shows the seat its exposure worsening.
- The one real window is **the Harrow Vein** (turns 34–45), which lifts
  Greyharrow's materials 60% for twelve turns — roughly 216 extra materials, in
  one city's hands, with a nine-turn private head start. That funds about three
  steps.
- **The Deep Gallery Collapse** (turn 52) then cuts Kilnspire's materials to 35%
  for ten turns, with six turns of private warning. A seat that spends its
  warehouse on building before turn 52 has discarded the buffer it is about to
  need, and it knew.
- A ceiling raise takes ~15 turns to fill at 1% growth, and the Long Frost stops
  growth at turn 78. Building after roughly turn 60 buys a ceiling the city will
  never reach.

### 6. `build` is one number in the action schema

A single integer: materials to put in this turn, 0 for none. Added to the five
fields already in `SEAT_ACTION_SCHEMA`, plus the known-field list in
`validate.ts`, plus a few lines of rules prompt. The prompt already tells every
model that growing "raises both your production and your consumption", so the
trade-off is in the briefing; this adds the lever.

**Scripted seats never build.** `build` is optional on `SeatAction` and
`ScriptedSeat` omits it. This is not a stub to fill in later — it is what keeps
the rest of the project honest. `npm run headless` and the genmap sanity gate
(`scripts/genmap.ts:236-247`) both run honest scripted seats, and that gate is
what certifies a scenario as survivable by honest cooperators (ADR-003). If
scripted seats built, every scenario's certification would shift and the
deterministic headless baselines would move, so a drift there could no longer be
read as a bug. Keeping them trade-only means gate results must come back
unchanged after this work lands, which turns the re-certification into a check
on the engine rather than a chore. It also leaves a scripted lineup usable as a
trade-only control.

### 7. Asymmetric access is accepted

Brinemark and Emberfall produce no materials, so every material they spend on
growth must be bought from a rival on top of what they need to survive. They can
barely build.

Accepted rather than fixed. Rotation gives every model two seats with easy
access and two without, so it is fair across models, and "can I buy my way into
growing" is a negotiation worth reading. Letting any resource fund building
would make it fair at the cost of materials being special.

### 8. One tournament-2 run, no control

Adding build changes the available actions, the rules prompt, and the ceiling
maths at once, so tournament 1 stops being a fair comparison — fewer betrayals
in tournament 2 could be the mechanic or the reworded prompt.

That is accepted, because the claim being made is "here is how each model used
building", which stands without a control. The stronger claim — "building
changed how models treat each other" — needs a paired run and is deferred to
tournament 3, which already commits to the paired design for weapons.

## Consequences

- Tournament 2 is not comparable to tournament 1's published table. Cross-
  tournament comparison in the Chronicle viewer becomes required rather than
  optional, and it must show which rules each tournament ran under.
- `v0.1.0` tags the trade-only rules so tournament 1 stays reproducible;
  `v0.2.0` will tag these.
- Every scenario's sanity gate re-runs, since the ceiling maths changed.
- Spoilage rides along in tournament 2 per the roadmap, on the grounds that
  tournament 2 already breaks comparability and re-runs tuning.
- Expansion makes the world's materials deficit worse: a city at 175 eats 17.5
  materials a turn instead of 15. Growth by one city tightens the world for
  everyone, which is a dynamic worth watching rather than a bug to fix.

## Rejected

- **Raising `maxGrowthFactor` instead.** Fixes the chart, measures nothing.
  Still available as a control run if tournament 2 suggests build changed
  bargaining behavior.
- **Fencing build off from delivery obligations** (engine reserves what is
  owed). Removes the tension the mechanic exists to create.
- **Patching the defection detector** to count recent build spend as stock still
  held. Correct in effect, but the phase ordering achieves it with no new rule.
- **Single-purchase tiers.** Needs a rule for the leftover, and punishes a city
  one material short. Also makes under-asking the safe play for every model,
  which flattens the differences being measured.
- **Scaling the warehouse limit with the ceiling.** Leaves expansion with upside
  and no bet.
- **A rule making large cities explicitly more fragile.** The shrinking cushion
  already does it.

## Revisit when

Tournament 2 finishes. The specific things that would move this: nobody builds
(prices too high, or the world too tight), everybody builds identically (no
decision), or expansion visibly changes bargaining behavior, which promotes the
paired control run from deferred to required.
