# POLIS — Ubiquitous Language

Domain terms with exact meanings. Code, docs, and writing use these words this
way; if a term drifts, fix the term or fix this file.

## Core

- **Seat** — the player interface to the engine (`Seat` in
  `src/engine/types.ts`). The engine knows seats, never models. A seat is
  filled by a model adapter or a scripted heuristic.
- **Scenario** — a committed, reproducible world definition
  (`scenarios/*.json`): terrain seed plus authored city sites, economies,
  names, lore, and slack. Authored once (by Fable, per ADR-001); never
  regenerated at run time.
- **Tournament** — a batch of Rotations of one lineup over one world, plus the
  cross-rotation summary. The unit of publishable results.
- **Rotation** — one complete run within a tournament, with the lineup shifted
  so each model governs a different city. Each rotation is its own causal
  timeline; rotations are comparable because the world is identical.
- **Chronicle** — the complete post-hoc record of one rotation: outcomes,
  events (with actor/target), diplomatic messages, per-tick journals and
  stockpile/population series, and offer/agreement lifecycles. Sufficient to
  tell the rotation's story without the raw call logs. Observer-omniscient by
  design: it publishes what was private in-game, after the run is over, and
  never feeds back into seats.
- **Chronicle Viewer** — the public HTML artifact for browsing a tournament's
  chronicles (Dwarf Fortress Legends-style).

## In-game

- **Agreement** — a promise: per-tick shipment terms both sides accepted.
  Never auto-transfers; see Delivery.
- **Delivery** — the per-tick act of fulfilling (or shorting) an agreement.
  The gap between agreements and deliveries is where defection lives.
- **Defection** — shipping essentially nothing on a due delivery while holding
  ample stock (engine-detected, recorded with actor and target).
- **Journal** — a seat's self-written memory string, fed back verbatim next
  tick. The only cross-tick memory a seat has; capped; telemetry gold.
- **Deficit resource** — the one resource a city cannot produce.
- **Shock** — a scenario-scheduled, named production modifier (city- or
  world-targeted, one resource or all, bounded multiplier and duration).
  Authored by the world architect; deterministic; by rule survivable by
  honest cooperators (ADR-003).
- **Forewarning** — true, private advance knowledge of a shock granted to its
  target city before the public announcement. The engine never lies; what the
  insider does with it is the measurement.
- **Transport efficiency** — the fraction of an origin-measured shipment that
  arrives, decreasing with distance (floored). Fulfillment is judged at
  origin; transit loss is never defection.

## Not the same thing

- **Run record** (`run-rot*.json`) — the summary-oriented output the runner
  writes today (outcomes, events, pop series, final journals). The Chronicle
  supersedes it as the full history; the run record stays as the compact
  summary.
- **Call log** (`*.jsonl`) — per-seat lab notebook: prompts, usage, retries,
  invalid actions. Provider-level noise; never part of the Chronicle.
