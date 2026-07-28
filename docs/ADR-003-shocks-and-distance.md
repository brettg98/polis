# ADR-003: Shocks and distance

Date: 2026-07-25
Status: accepted

## Context

Runs to date reveal a realism failure that weakens the benchmark: the world is
stationary, so the trade network locks in by ~tick 10 and diplomacy goes
static. Shocks create the renegotiation-under-pressure behavior the benchmark
exists to measure. Separately, distance does nothing — geography is
strategically cosmetic. Decided in a grill-me session, 2026-07-25.

## Decision

### Shocks

1. **Fable-authored, scenario-scheduled.** Shocks live in the scenario file
   (named, narratively motivated, deterministic across rotations). No engine
   randomness. Hand-authored schedules are equally valid (it's just JSON).
2. **Production multipliers only.** `{name, description, target: city|'all',
   resource|'all', startTick, duration, multiplier, visibility,
   forecastLead?, privateWarning?}`. No stockpile destruction, no
   consumption/population effects (deferred with the spoilage bundle).
3. **Public, with per-shock forecast-or-surprise**, exposed *structurally* in
   observations (`world.shocks` announced/active), never prose-only.
4. **Private forewarnings** (the deception instrument): a city-targeted shock
   may grant its target true, private advance knowledge M ticks before the
   public learns, via a private `you.forewarnings` observation field. The
   engine never lies; no noisy intel; no formal intel-trading (messages cover
   that). Fairness holds because asymmetry belongs to the seat and rotations
   cycle every model through the informed chair. The Chronicle records
   who-knew-when.
5. **Rails** (validated in `scenarioProblems`, enforced by the genmap sanity
   gate): multiplier ∈ [0.25, 1.75]; duration ∈ [3, 15]; first onset ≥ t15;
   ≤ 6 shocks; no same-city+resource overlap; ≤ 2 concurrently active;
   forecastLead ∈ [3, 8]; privateWarning ∈ [forecastLead+2, 12] (forecast) or
   [3, 12] (surprise), city-targeted only. **Governing principle: every
   schedule must be survivable by honest cooperators** — the scripted-honest
   sanity sim runs past the last shock and any collapse rejects the scenario.
6. **kilnspire-ledger is amended, not regenerated**: one Fable call adds a
   history consistent with its own design notes → versioned `-v2` file. The
   shock-free original remains valid (shocks are optional in the schema) and
   keeps its baseline runs comparable.

### Distance

7. **Transit loss, origin-measured.** Receiver gets `qty × efficiency`;
   `efficiency = max(0.60, 1 − 0.0025 × distance_cells)` (engine constants in
   `config.trade` for v1). Agreement quantities and fulfillment are measured
   at ORIGIN — transit loss is physics, never defection. Per-counterparty
   efficiency is exposed in observations; pricing distance into deals is the
   models' job. No transit delay (would desynchronize the delivery/
   retaliation loop and invalidate all prior comparisons).

## Consequences

- Seat prompt grows two sections (shocks, transport) — identical for all
  models per the fairness policy.
- On kilnspire-ledger the pair efficiencies span ~87% (closest) to ~77%
  (farthest), favoring regional blocs without walling anyone off.
- Earlier runs are not comparable to post-ADR-003 runs; the tournament is the
  baseline.

## Rejected / deferred

- Engine-rolled random shocks (no design intent, unquotable).
- Stockpile destruction and demand-side shocks (spoilage bundle).
- Asymmetric *noisy* intel and formal intel markets.
- Destination-measured quantities; transit delay.
- All-forecast or all-surprise regimes (each kills a measured behavior).

## Revisit when

Rails prove mistuned in real runs; a scenario wants per-world transport
constants; or the espionage feature set arrives.
