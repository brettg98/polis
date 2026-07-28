# ADR-001: POLIS goal, scope, and publish commitment

Date: 2026-07-25
Status: accepted

## Context

POLIS started as a late-night idea: a city simulator where cities need three
resources but can only produce two, forcing trade and enabling betrayal. A v1
with terrain generation, a deterministic economy engine, and scripted seats was
built and verified on 2026-07-25 (autarky collapse at tick 16, trade sustains
indefinitely).

The open question was whether this is a toy or an asset. Brett is a solo
consultant, and September needs visible, differentiated content. Ethan
Mollick's Fable 5 coverage (June 2026) shows
public appetite for "watch models do surprising things," and nobody in that
wave is running models as players under reproducible conditions.

## Decision

1. **Goal:** run a reproducible mixed-model tournament and publish the results.
   The deliverable is one headline chart (thrived / exploited / defected-first
   per model) backed by seeded replays, logs, and seat journals.
2. **Lineup is cross-vendor:** Anthropic models plus OpenAI and Gemini seats.
   The vendor-neutral comparison is the content differentiator and matches the
   consulting position.
3. **Open source with the writeup**, including a public browser demo. The
   benchmark being runnable by others is part of the pitch.
4. **Publish deadline: 2026-08-31.** Anchor blog post on curiousorbit.com;
   September is distribution month (LinkedIn, Talking Cloud, OrbitWEEKLY).
5. **Kill criterion: 2026-08-09.** If LLM seats aren't wired and producing
   interesting behavior after two lab sessions, shelve it.
6. **Cadence constraint:** weekend lab slots only. This project must not
   displace client delivery work.

## Consequences

- The LLM seat layer needs provider adapters (Anthropic, OpenAI, Google) behind
  the one `Seat` interface, plus a key-proxy for browser mode, call logging,
  token budgets, and identical validation/retry rules across providers.
- Everything between now and the chart is in scope; terrain polish, military
  mechanics, and product features are not.
- Open-sourcing means the README, license, and secret hygiene must be
  stranger-ready before publish.
- Estimated tournament cost is low hundreds of dollars at current API pricing
  (journals keep per-call input constant; prompt caching halves input cost).

## Addendum 2026-07-25: providers, gateway, and fairness

- **Non-Anthropic seats route through OpenCode Zen** (OpenAI-compatible
  gateway, `OPENCODE_API_KEY`): GLM 5.2 and the GPT seat both, one adapter,
  one billing surface. Direct OpenAI remains available
  through the same adapter (`openai:` provider prefix) if billing or capability
  reasons emerge.
- **Fable's role is world-architect, not mayor**: it generates committed
  scenario files (`scenarios/*.json`), preserving seeded reproducibility.
  Runs load scenarios; Fable is never called at tick time.
- **Fairness policy**: each provider gets its best structured-output mechanism
  (Anthropic structured outputs; OpenAI-compat `json_schema` with automatic
  fallback to `json_object` + schema-in-prompt where unsupported). The
  equalizers are identical validation, an identical one-retry-then-pass rule,
  and identical observation/journal limits. Schema-failure and retry rates are
  logged per seat and reported as a metric in the writeup.
- **Target lineup**: Opus 5, Sonnet 5, GPT (via Zen), GLM 5.2 — two Anthropic
  tiers, one closed rival, one open model, on a Fable-designed map.

## Revisit when

The tournament runs, the checkpoint fails, or a provider change materially
shifts cost or capability assumptions.
