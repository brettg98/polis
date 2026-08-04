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
~~specifically how risk-averse each one is~~. Decided in a grill-me session,
2026-07-29.

> **The risk-appetite half of that goal is withdrawn (2026-08-04, #28).** No
> city in any completed run has reached a ceiling it bought, so the spend never
> carried the risk it was meant to price. What survives is the first half: how
> differently models handle the bet, which the runs do show. See the third
> amendment.

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
  comes out of the warehouse, which is what was expected to make it a risk
  decision, and `ticksUntilShortage` already shows the seat its exposure
  worsening. (The spend is real and the exposure is real; what did not follow is
  a payoff to weigh them against — #28, third amendment.)
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

## Addendum, 2026-07-31: what the calibration rotation showed

A single rotation was run before the tournament proper to settle issue #10 with
evidence rather than argument. One rotation, 100 ticks, `kilnspire-ledger-424242-v2`,
the tournament-1 field with GLM on the direct Z.ai route. All four cities
survived. No seat failed a call. $10.55.

| model | city | final pop | ceiling | steps | materials spent | ceiling used |
|---|---|---|---|---|---|---|
| Sonnet | Kilnspire | 152 | 275 | 5 | 647 | 55% |
| GLM | Greyharrow | 111 | 225 | 3 | 231 | 49% |
| Terra | Emberfall | 48 | 200 | 2 | 125 | 24% |
| Opus | Brinemark | 40 | 200 | 2 | 125 | 20% |

Every model built. None came close to filling what it bought. The spending
styles were sharply different — Terra put 125 into three ticks including a
single dump of 75, GLM dribbled 231 across thirteen ticks in amounts from 1 to
15, Sonnet spent 647 steadily. On the ADR's own success criterion (models
diverge in how they use build) this is a pass.

### The growth gate and the build currency are the same resource

Not anticipated when the prices were set. Population growth is gated at
`sim.ts:235` on all three stockpiles exceeding `stockpileCap × 0.25` = 50.
Materials is both the currency building spends and one of the three resources
that gate holds. Completing a step therefore pushes a city toward the condition
that stops it growing into the ceiling it just bought.

Measured over the rotation, counting ticks where a city did not grow:

| city | ticks not growing | materials the only stockpile under 50 |
|---|---|---|
| Greyharrow (GLM) | 90 | 89 |
| Emberfall (Terra) | 73 | 60 |
| Kilnspire (Sonnet) | 58 | 38 |
| Brinemark (Opus) | 98 | 23 |

All twelve completed steps were followed by no growth on the next tick. The
clearest case is Kilnspire, a materials producer with a real surplus: 87.8 → 19.5
at t17 and 100.7 → 32.2 at t63, each time spending itself from comfortably above
the gate to well below it.

### Decision: leave the gate alone

Resolves #10 with its own option 1, on evidence rather than in advance.

The interaction is not a defect. It is the mechanic discriminating: Sonnet had a
genuine materials surplus, spent the most, and finished largest with the best
utilisation; the two cities without a surplus spent the minimum and got nothing
for it. Build rewards a city that can afford it and punishes one that cannot,
and three of four models could not tell which they were. That is a better
finding than the one this ADR set out to produce.

Changing the gate now would invalidate the calibration run, cost another
rotation of money and hours, and replace a measured behaviour with a guessed
constant — which section 4 already refused once, for the same reason.

Also worth recording: the rules prompt tells every seat, every tick, that "a
ceiling bought late is a ceiling you never fill." Four out of four bought
anyway. Opus, having reached ceiling 200 in the hardest seat on the map and then
sat at population 40 for sixty ticks, wrote `ceil200 -> NEVER BUILD` into its
journal and held to it. That reversal is visible only because the journal is the
seat's whole memory.

### Limits of this evidence

One rotation, no seat rotation, so Sonnet's result is confounded with Kilnspire
being a strong seat — the trap tournament 1 documented when its hardest seat
finished at 119, 49, 109, and 150 under four occupants. And "materials was the
only stockpile under the gate" is not proof that building caused the shortfall:
Brinemark produces no materials and would be short regardless. Kilnspire is the
one city where the causation is legible in the numbers, because it spent itself
across the threshold from a surplus it had earned.

## Second addendum, 2026-08-03: the full tournament confirms it, and the ceiling turns out to be decorative

The addendum above decided #10 from one unrotated rotation and listed the
confound it could not remove. Tournament 2 finished afterwards, and with seat
rotation the confound is gone. Measured across `runs/t2-full` (4 rotations ×
100 ticks) and `runs/t3-test60` (1 rotation × 60 ticks), 20 city-runs in total,
against `runs/tournament-main` (4 rotations × 100 ticks) for the pre-build
comparison.

The gate is at `sim.ts:286` now; the build phase moved it from the line 235 the
addendum above cites.

Method: for every city-tick, take the end-of-tick stockpiles the gate tested,
skip ticks where the city was in ruins, was starving, or was already at its
ceiling, and classify the rest as grown or gate-blocked. Reconstructing growth
from the recorded stockpiles agrees with the recorded population on 1,472 of
1,472 eligible city-ticks, so the classification is the engine's own, not an
approximation of it.

### The decision holds, and the reason is stronger than "leave it and observe"

| | tournament 1, no build | tournament 2, build |
|---|---|---|
| city-runs reaching population 150 | 10 of 16 | 0 of 16 |
| mean peak population | 138.1 | 117.0 |
| eligible ticks where growth was gate-blocked | 46.3% | 81.8% |
| ticks spent already at the ceiling | 423 | 0 |
| materials the sole stockpile under the gate | 84.2% of blocked ticks | 78.9% |

Issue #10 asked whether the gate gets relatively easier as a city grows, since
50 units is five turns of cover at population 100 and under three at 175, and
whether that offsets the shrinking cushion expansion relies on for its downside.

The premise never engages. The relative easing only starts to matter above
population 150, and across all five completed rotations the highest population
any city reached is 143.1. Not one city-run exceeded even its *starting* ceiling
of 150, let alone a raised one. The block rate does fall as population rises
(91.9% below 100, 80.2% at 100–124, 69.2% at 125–149), but a city at 125 is a
city trading well, and trading well is what fills stockpiles, so that gradient
cannot be read as the gate loosening on its own.

Option 2, making the gate proportional to consumption, would tighten a
constraint that already blocks four growth opportunities in five. On this
evidence it is the wrong direction. #10 closes on option 1, as the addendum
above decided.

### What the rotated data adds: the ceiling is not reachable

Twenty of twenty city-runs spent materials on ceiling. 4,086 materials in total.
None of them reached a population that required any of it.

Materials was short on 93.6% of gate-blocked ticks and was the only resource
short on 80.5%, holding across every seat and every model rather than only in
the cities that produce none. That is the same interaction the addendum above
identified, now measured with the seats rotated: the currency build spends is
the resource that gates growth, so a city funds a ceiling by moving itself away
from the condition that would let it climb.

The addendum above read this as the mechanic discriminating between cities that
can afford it and cities that cannot, and that reading stands. What the rotated
data adds is that the discrimination happens entirely below the old cap. Nobody
is buying headroom and filling part of it. Everybody is buying headroom and
filling none of it, because the binding constraint on population was never the
ceiling.

### What this does not establish

Tournament 1 and tournament 2 differ in the build action, the prompt, and the
ceiling arithmetic at once, which decision 8 accepted deliberately. So "build
lowered the board" is a hypothesis with a mechanism and an association behind
it, not a demonstrated cause. A paired run under one ruleset is what would settle
it, and none exists.

Against this ADR's own success criterion the mechanic still passes: models
diverge sharply in how they use build, which is what it was added to measure.
What is now in question is narrower and is a tuning matter rather than a design
one, so it goes to an issue rather than being decided here: a purchase that
cannot change any outcome is not a risk decision, and reading these runs as
evidence about risk appetite assumes it was.

## Amendment, 2026-08-03: the growth gate is measured in ticks of cover (#29)

The addendum above says option 2 of #10 — making the gate proportional to
consumption — is the wrong direction on the evidence. That is now half right and
is corrected here rather than edited away, because the reasoning behind it still
holds for the case it was actually about.

**What was conflated.** How the gate is *expressed* and how *strict* it is are
independent, and #10 treated them as one decision. Re-expressing the gate at
unchanged strictness does make growth rarer, which is what #10 rejected and it
was right to. Re-expressing it while lowering the threshold is a different
change, and it is what #29 implements.

**The defect being fixed.** The threshold was `stockpileCap × 0.25` where
`stockpileCap` is anchored to `startPopulation` and therefore never moves, while
consumption tracks live population and does. So a flat 50 bought 5 ticks of
cover at population 100 and 2.9 at 175. The rule loosened as a city grew, which
runs against decision 3 above, where a growing city is meant to get *more*
fragile. It also could not be stated to a seat in one sentence, which is part of
why `prompt.ts` describes it only as "all three stockpiles are healthy".

**The rule now.** Growth requires more than `growthGateTicks` ticks of current
consumption in every resource. It means one thing at every size, and the sentence
is writable: *you grow while you are holding N turns of food, energy, and
materials.*

**N = 2.5, chosen by sweep.** Honest scripted seats, both committed scenarios,
200 seat-RNG samples per level, run against the old rule as a control. Scripted
seats never build, so the ceiling stays at 150 and the gate is the only thing
that can stop growth.

`kilnspire-ledger-424242-v2`, 98 ticks:

| gate | growth ticks/run | runs with a death | cities at cap | mean final pop |
|---|---|---|---|---|
| flat 50 (old) | 158.0 | 135/200 | 1.59 | 102.1 |
| N = 2 | 203.6 | 114/200 | 2.13 | 109.7 |
| **N = 2.5** | **198.2** | **113/200** | **2.15** | **110.0** |
| N = 3 | 186.8 | 131/200 | 2.02 | 107.0 |
| N = 3.5 | 179.6 | 126/200 | 1.80 | 106.8 |

`kilnspire-ledger-424242`, 60 ticks:

| gate | growth ticks/run | runs with a death | cities at cap | mean final pop |
|---|---|---|---|---|
| flat 50 (old) | 127.1 | 8/200 | 1.09 | 122.5 |
| N = 2 | 162.9 | 8/200 | 2.51 | 131.8 |
| **N = 2.5** | **157.7** | **7/200** | **2.44** | **130.5** |
| N = 3 | 150.5 | 6/200 | 1.93 | 127.8 |
| N = 3.5 | 143.2 | 8/200 | 1.33 | 125.9 |

2.5 beats the old rule on every measure in both scenarios, and it lowers the
death rate rather than buying growth with collapses. It is not so loose that
growth is free: 2.15 of 4 cities reach the cap in v2, not 4 of 4. Values below 2
were dropped for being close to unconditional, and 5 — which is what the old
rule means at population 100 — is worse than the old rule on growth in the
60-tick scenario, which is the arithmetic #10 predicted.

**A single sample would have chosen differently.** On one seat-RNG draw, N = 1,
2 and 4 each killed a city in v2 while 2.5, 3, 3.5 and 5 did not, which reads as
a threshold and is not one. Across 200 draws every level kills a city in most
runs. That is the project's own recurring lesson, and it produced #30.

**Related, and not caused by this change:** measuring the control exposed that
the ADR-003 sanity gate certifies from one seat-RNG draw. Under the *old* rule
`kilnspire-ledger-424242-v2` kills a city in 135 of 200 draws, and the single
draw the gate tests is one of the survivors. Filed as #30.

**What this does not do.** It does not resolve #28. More cities now reach 150,
which makes a purchased ceiling matter for the first time, but nothing here puts
a raised ceiling within reach of a 100-tick run on its own.

**Comparability.** Tournament 3 is not comparable to tournaments 1 or 2 on
population. This is the second deliberate break, after decision 8.

## Third amendment, 2026-08-04: the risk-appetite claim is withdrawn (#28)

Decided by Brett, 2026-08-04, taking option 1 of #28.

**What is withdrawn.** This ADR's stated goal was to see how risk-averse each
model is. That claim is dropped. It required a purchased ceiling to carry a real
trade-off — spend now, grow into it later, and be poorer if a shock lands
first — and the second half never happened. Across 20 city-runs no city reached
a ceiling it bought, so the runs record which models spent on a non-functional
item, which is a different and weaker claim. Any sentence in the writeup reading
model behaviour here as evidence about risk tolerance should be cut.

Confirmed again after the gate change of #29: in `runs/t3-gate60`, two cities
bought ceiling to 200 and finished at 76 and 125, with ceiling utilisation of
38%, 63%, 42% and 73%.

**What stands.** Models diverge sharply and legibly in how they use build, which
is this ADR's own success criterion from decision 8 and is worth publishing on
its own. The measured spending styles are real: Opus dribbling across many
ticks, Sonnet spending steadily and largest, Terra not building at all in
`t3-gate60`, GLM banking 34 materials for fifty ticks without ever affording the
first 50-material step. The ordering-of-phases result from decision 1 also
stands, and was confirmed against real models — Greyharrow's overreach shorted
its own build every tick, never its partners.

**What was rejected, and why now.** Making the ceiling reachable, or decoupling
the build currency from the growth gate, both change `src/engine/` and would
make a third tournament incomparable to the first two for a second reason.
Neither is refused on merit; the decoupling idea is the stronger design and is
held as a tournament-4 question. With the writeup due 2026-08-31 and two
tournaments already run, correcting the claim costs nothing and changing the
mechanic costs comparability.

## Fourth amendment, 2026-08-04: a city has now passed the base ceiling (#34)

The third amendment above says no city in any completed run has reached a
ceiling it bought. **That is no longer true**, and it stopped being true within
hours of being written. Correcting it here rather than editing it, because it
was an accurate statement of 28 seat-runs at the time.

`runs/t3-gatevisible60` — same seed, scenario, lineup and seat assignment as
`runs/t3-kimi60`, differing only in the prompt change and observation field from
#34. Terra's Kilnspire **peaked at 158 and finished at 156**. Every prior
city-run in this project's history topped out at 146, and none had exceeded the
base ceiling of 150.

| model | seat | population, gate hidden → visible | reliability | ceiling used |
|---|---|---|---|---|
| Terra | Kilnspire | 146 → **156** | 78% → 82% | 78% |
| Kimi | Greyharrow | 138 → **146** | 82% → **98%** | 73% |
| Opus | Brinemark | 62 → **94** | 65% → 81% | 47% |
| GLM | Emberfall | 35 → **41** | 85% → 94% | 23% |

### What this changes about the mechanic

**The ceiling is not decorative. It is conditional on the seat.** Terra and Opus
made the same purchase on the same tick — a first step at t6, with roughly 46
points of unused headroom under a cap of 150. Terra grew through the base
ceiling and used what it bought. Opus fell from 105 to 94 and used 47%. The
difference is that Kilnspire produces materials, so it could fund the ceiling
and keep clearing the growth floor; Brinemark produces none and had to choose.

So the finding in the second addendum — that build is a materials sink which
suppresses the growth it sells — holds for importing seats and fails for
producing ones. It was measured on a fleet where nothing had ever reached the
cap, which made a conditional effect look absolute.

### What is properly established, and what is not

Established, because it is visible in the journals rather than inferred from a
population column: seats read the new `growthFloor` field and reason with it.
GLM held a build while *"Mats still below growthFloor 26.9"*; Terra withheld a
delivery *"to preserve reserve/growth floor"*, choosing a diplomatic cost over
dropping below the line. All four seats converged on spending exactly 125
materials, against 155 / 50 / 25 / 140 in the paired run.

**Not established: that the prompt change caused the population rise.** All four
seats improved on population and reliability, which looks like eight independent
measures agreeing and is not — the seats share one economy, so a better world
lifts everyone together. This is one run against one run, in a project that has
already recorded run-to-run variance reversing two cities and killing one that
survived elsewhere. Treat the population figures as a single sample and the
journal behaviour as the finding.

### Still standing

Nothing here reopens the engine. #28's decision to leave the mechanic alone is
unchanged, and the risk-appetite claim stays withdrawn: a purchase whose payoff
depends on which chair you occupy measures the chair at least as much as the
occupant, which is this project's oldest result.
