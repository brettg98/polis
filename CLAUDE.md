# POLIS

A reproducible benchmark for how LLMs negotiate, cooperate, and betray each
other, dressed as a low-poly city simulator. Models sit in the seats; the sim
is the instrument.

## Goal

Publish a cross-vendor tournament writeup. Everything must feed the
tournament chart. Challenge scope creep. Full goal, scope, and locked
decisions: `docs/ADR-001-goal-and-scope.md`.

## Hard rules

- Engine stays headless: nothing in `src/engine/` imports rendering code.
- All randomness through `RNG` — no `Math.random()` in the engine.
- API keys via env only; never committed, never shipped to the browser.
- Seat validation/retry rules identical across providers (fairness is the
  point of the benchmark).

## Commands

- `npm run dev` — browser sim (URL params: `seed`, `trade=0`, `opp=0`,
  `cities`, `scenario`)
- `npm run headless` — terminal verification runs
- `npm run smoke -- --seat <spec>` — single-seat LLM smoke test
- `npm run tournament -- --outDir runs/<name>` — tournament runner
  (`--startRotation` resumes; a `PAUSE` file in outDir idles between ticks)
- `npm run genmap` — LLM-authored scenario/map generation
- `npm run chronicle` — build the Chronicle viewer from run logs
- `npm run typecheck` / `npm run build`

## Tech stack

- TypeScript (strict, ESM), Vite for the browser sim, `tsx` for scripts
- three.js rendering, simplex-noise terrain, `@anthropic-ai/sdk` for
  Anthropic seats; other providers via OpenAI-compatible fetch (no SDK)
- No test framework: verification is `npm run typecheck` plus deterministic
  headless runs (same seed, same outcome)

## Architecture

```
scripts/ (headless, smoke, tournament, genmap, chronicle)
   → src/engine/    (headless sim: terrain, cities, economy, RNG, scenarios)
   → src/llm/       (seat adapters, prompt, schema, validation, factory)
   → src/chronicle/ (run capture + HTML viewer)
src/render/ + src/main.ts (browser only; imports engine, never the reverse)
```

- Seat specs are `provider:model` strings resolved in `src/llm/factory.ts`.
- Scenario files live in `scenarios/`; generated worlds are checked in so
  tournaments are reproducible.
- `runs/` is gitignored: raw LLM call logs, chronicles, and tournament
  output stay local.

## Workflow

- Solo project; direct commits to `main`. Short imperative commit subjects;
  `docs:`/`fix:` prefixes welcome but not enforced.
- Coding work items are GitHub issues on this repo.

## Docs

- `docs/ADR-001-goal-and-scope.md` — goal, decisions
- `docs/ADR-002-the-chronicle.md` — chronicle + viewer
- `docs/ADR-003-shocks-and-distance.md` — shocks, distance model
- `docs/design.md` — architecture, tuning knobs
- `docs/llm-seats.md` — seat wiring notes (read before touching adapters)
- `CONTEXT.md` — glossary / ubiquitous language
