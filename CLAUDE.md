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
- `npm run verify:build` — build-phase acceptance cases (no keys, deterministic)
- `npm run verify:backoff` — retry-delay acceptance cases (no keys, no network)
- `npm run verify:scenarios` — re-certify committed scenarios against the
  ADR-003 sanity gate; run after any economy or tuning change
- `npm run typecheck` / `npm run build`

## Tech stack

- TypeScript (strict, ESM), Vite for the browser sim, `tsx` for scripts
- three.js rendering, simplex-noise terrain, `@anthropic-ai/sdk` for
  Anthropic seats; other providers via OpenAI-compatible fetch (no SDK)
- No test framework: verification is `npm run typecheck`, the deterministic
  headless runs (same seed, same outcome), and the `verify:*` scripts. The
  latter assert named properties and exit non-zero on failure, so they are
  the closest thing here to a regression suite.

## Architecture

```
scripts/ (headless, smoke, tournament, genmap, chronicle, verify-*)
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

### Order of work — nothing gets built before it is agreed and written down

1. **Discuss** — the problem, the options, the trade-offs.
2. **Decide** — an explicit decision. A discussion is not a decision, and a
   convincing argument for something is not approval of it.
3. **Write it down** — a GitHub issue for code, well defined and concise.
   Human work goes on the kanban board instead. Decisions that are hard to
   reverse also get an ADR in `docs/`.
4. **Implement** — against that issue, not against the conversation.

Code written without an issue is out of process no matter how good the reason.
A question is a request for an answer, not a licence to build: answer it, then
stop. If the answer suggests something should be built, say so and wait for
step 2.

Urgency does not skip steps. "This has to happen before the next run or the
data is lost" is a reason to reach a decision quickly, not a reason to decide
alone.

### Autonomy level

Level 4 on Dan Shapiro's scale — developer as product manager. Work is
specified as an issue, an agent implements against it, a human reviews.
Deliberately not Level 5: nothing here gets built from conversation alone.

The step down is because this project has none of the infrastructure
guardrails that make Level 5 safe elsewhere — no CI, no separate cloud
account, and a public repo with a manual publish path. Review of intent is
the guardrail, and the step-3 issue is where it happens.

The gate is on what can change a result, not on how much code is involved:

| surface | gate |
|---|---|
| `src/engine/`, `src/llm/`, `scenarios/` | issue first, always |
| everything else — docs, viewer, scripts, tooling | just ask |

Bugs here do not cause outages, they corrupt results, and a corrupted result
is worse because it is silent and it gets published. A tournament also costs
real money and hours and cannot be re-run for free, so an undocumented change
to the measuring surface between runs makes two tournaments incomparable with
no way to detect it afterwards.

"Is it code" is the wrong question. `src/llm/prompt.ts` is prose and is among
the most result-critical files in the repo; `src/chronicle/html.ts` is
hundreds of lines that cannot change a single outcome.

Where an agent's global instructions conflict with this file, this file wins.

## Docs

- `docs/ADR-001-goal-and-scope.md` — goal, decisions
- `docs/ADR-002-the-chronicle.md` — chronicle + viewer
- `docs/ADR-003-shocks-and-distance.md` — shocks, distance model
- `docs/ADR-004-expansion.md` — tournament-2 build phase (designed, not built)
- `docs/ADR-005-reasoning-effort-and-tournament-1.md` — what the tournament-1
  results mean, and the rule that effort is swept for all seats or none
- `docs/design.md` — architecture, tuning knobs
- `docs/llm-seats.md` — seat wiring notes (read before touching adapters)
- `CONTEXT.md` — glossary / ubiquitous language
