# LLM seat wiring notes

Read before building the provider adapters.

## Structure

- Two adapters cover everything: `AnthropicSeat` (Anthropic SDK) and
  `OpenAICompatSeat` (plain fetch against any OpenAI-compatible endpoint —
  Z.ai direct, the OpenCode Zen gateway, OpenAI direct). Shared prompt
  assembly in `prompt.ts`; only the transport differs.
- Seat specs are strings via `factory.ts` (`anthropic:claude-opus-5`,
  `zai:glm-5.2`, `opencode:<gpt-model>`, `openai:<model>`) so lineups are
  config, not code.
- The compat adapter probes capabilities once and remembers: `json_schema` →
  `json_object` + schema-in-prompt fallback, `max_tokens` →
  `max_completion_tokens`. Adaptations are logged and don't consume the
  fairness retry.
- Prompt = stable rules/schema system prompt (identical across seats and
  ticks — this is what makes prompt caching work) + per-tick observation JSON
  + the seat's journal. Keep anything volatile out of the system prompt.
- Output = action JSON matching `SeatAction` + a journal string (cap ~2K
  tokens). Use each provider's structured-output mechanism where available.

## Which route a model takes, and why it matters

Anthropic and Z.ai go direct. Everything else goes through the OpenCode Zen
gateway.

That split is measured, not stylistic. Zen resells at the vendor's list price
($1.40/$4.40 for GLM 5.2, identical to Z.ai's own), so it earns nothing on
tokens and caps the models that consume the most. Across four attempted
tournament runs, `glm-5.2` through Zen behaved as a token bucket refilling at
**~170 output tokens per minute**, with the largest bucket ever observed around
66,000 tokens after an overnight rest. A 100-tick rotation needs ~467,000
output tokens, so the route could not finish a run at any start time — four
attempts died at ticks 16, 5, 6 and 9.

The same probe run against Z.ai direct pushed 30 consecutive calls and ~72,500
output tokens with no rate limit and no ceiling found, sustaining ~3,900 output
tokens per minute against the ~2,800 a rotation requires.

Appetite is what decides it, not the gateway as such. GPT 5.6 Terra averages
~688 output tokens per call against GLM's ~4,669 — roughly a seventh the cost
to serve — and completed a full four-rotation tournament through Zen without a
single rate limit. Light models stay on the gateway; heavy ones go direct.

**Route affects reported usage, so it affects the cost table.** Z.ai reports
reasoning tokens explicitly (`completion_tokens_details.reasoning_tokens`, plus
a separate `reasoning_content` field). Zen does not for the GPT route, which is
the source of the +33% understatement on Terra recorded below. So GLM's cost
figures become accurate on the direct route while Terra's remain a floor. That
asymmetry is now a deliberate trade rather than an oversight, and it is one more
reason to publish measured tokens and treat dollars as approximate.

**Provenance:** tournament 1's GLM ran through Zen. Any later tournament runs it
direct. Same model, different transport, and potentially different fidelity in
the numbers — worth stating in a writeup rather than leaving implicit.

## Keys and transport

- Seats read API keys from environment variables only (`ANTHROPIC_API_KEY`,
  `ZAI_API_KEY`, `OPENCODE_API_KEY`, `ANTHROPIC_MAPGEN_API_KEY`). Inject them at launch
  from your secret manager of choice; values never touch disk or git.
- Anthropic seat calls bill to the API key's Console org (metered). Check
  the org's spend limits before tournament runs; Fable map generation
  requires the org to have 30-day data retention.
- City seats and the map generator use separate keys so tournament spend is
  attributable per function.
- Headless mode reads provider keys from env directly. Model seats exist only
  there: `scripts/` (smoke, tournament, genmap) is the only entry point that
  constructs one.
- **The browser makes no provider calls.** `src/main.ts` wires `ScriptedSeat`
  only, so there is no key in the client and nothing to proxy. ADR-001 lists a
  browser key-proxy as a consequence; it was never built, and a browser lineup
  would need one before any model seat could run there.

## Cost figures are estimates, and they are biased per provider

Reconciled against the provider invoices on 2026-07-26 (tournament 1,
covering every POLIS call including false starts and smoke tests):

| model | invoiced | our estimate | invoice vs estimate |
|---|---|---|---|
| claude-opus-5 | $23.13 | $22.51 | +2.8% |
| claude-sonnet-5 | $6.62 | $6.60 | +0.3% |
| glm-5.2 | $16.85 | $15.41 | +9.3% |
| gpt-5.6-terra | $9.76 | $7.34 | **+33.0%** |

- **Sonnet 5 is on intro pricing** ($2/$10) through 2026-08-31. The table
  used list ($3/$15) and overstated Sonnet by 33%; corrected, the estimate
  lands within 0.3% of the invoice, which is the control that says the
  estimator arithmetic itself is sound.
- **Terra's cost is a floor.** Zen does not report reasoning tokens for the
  GPT 5.6 route — 694 mean reported output tokens per call against GLM's
  6467 for identical work — while billing them.
- **GLM runs ~9% under**: timed-out calls generate billable tokens but
  return no usage payload, so they cost money we never see.
- Anthropic's residual is unlogged Console usage plus early smoke tests.
- Whole-project spend for tournament 1 was $56.85 ($30.24 Anthropic
  including $0.49 of Fable map generation, $26.61 Zen). The $42.35 in
  `summary.json` counts only the final four-rotation run; the rest went to
  false starts, aborted attempts, and tests.

Consequence: publish token counts (measured) and treat dollars as
approximate. A cost ranking between vendors from these numbers alone is not
defensible; the Sonnet and Terra biases point in opposite directions and are
together large enough to reverse the bottom of the table.

## Fairness rules (identical across providers, or the comparison is polluted)

- Every action is validated client-side (`validate.ts`) regardless of
  transport — gateways can silently drop `response_format` (observed: Zen
  ignores `json_schema` for GPT 5.6 over chat/completions; the compat seat
  detects this via validation failure and flips to schema-in-prompt).
- Malformed action → validation errors fed back for exactly one retry, then
  the seat passes the tick (no action, journal preserved).
- Timeouts get the same one-retry-then-pass treatment.
- **Same retry timing.** When the first attempt failed for a reason a pause
  might fix — HTTP 429, 5xx, a timeout, a dropped connection — the retry waits
  before going again: `Retry-After` when the provider sends one, otherwise 5s,
  capped at 20s so one sick provider cannot stall a tick every other seat is
  waiting on. A malformed or unparseable action retries immediately, because
  waiting does not improve it. Both adapters call `retryDelayMs` in
  `src/llm/backoff.ts`; the policy lives in one file so a longer grace period
  cannot drift into one provider's path. This changes the timing of the second
  attempt, never the count, so the one-retry rule above still holds.
- Same observation schema, same journal cap, same max tokens per call.
- **Same reasoning effort.** One `REASONING_EFFORT` constant in `factory.ts`
  (currently `low`) is sent to every seat: as `effort` to the Anthropic SDK and
  as `reasoning_effort` on compat routes. If a provider rejects the parameter
  the seat drops it and logs the drop, because a seat thinking without a cap is
  not playing under the same rules as the others.

### This rule was stated but unenforced until 2026-07-30

Only the Anthropic seats were ever capped. The compat adapter sent nothing, so
every other provider ran at its own default:

| seat | sent | actually ran at |
|---|---|---|
| Opus, Sonnet | `effort: 'low'` | low |
| GPT 5.6 Terra | nothing | medium (the documented GPT-5.6 default) |
| GLM 5.2 | nothing | near-maximum |

Measured on identical prompts, `glm-5.2` produced 6,122 output tokens at its
default against 1,078 at `low` — 93% of the former being reasoning. In a live
run it sat at 10,000–14,500 tokens per call against the 16,000 ceiling and
eventually exhausted it mid-tick, returning empty content and passing the tick.

**Tournament 1 ran under this asymmetry.** GLM won it while deliberating
several times longer than the Anthropic seats were permitted to. Any comparison
across that boundary has to say so.

Equalising it cut GLM to ~2,200 output tokens per call, latency from ~120s to
~24s, and cost by about 70%.

## Cost controls

- Log every call: prompt, response, token usage, latency. This is both the
  replay record and the cost ledger.
- Per-run token budget guard: abort past a configurable ceiling.
- Reasoning effort is `low` for every seat (see the fairness rules above). It is
  also the single biggest cost lever: GLM's spend is almost entirely reasoning
  tokens, and capping it cut a run's cost by ~70% and its wall time by ~5x.
  Effort level remains an experimental variable worth sweeping — but sweep it
  for all seats at once, never one provider at a time.
- Estimated ~$2–20 per 100-tick 4-seat run depending on model tier; negotiate
  subrounds roughly double it. Parallel seeds share the prompt cache within a
  provider.

## Caching notes

- The rules prompt caches on Anthropic models (Opus 5 minimum cacheable prefix
  is 512 tokens). Haiku 4.5's minimum is 4096, so a ~2K rules prompt silently
  won't cache there — acceptable (Haiku input is cheap) or pad past the
  threshold.
