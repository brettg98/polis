# LLM seat wiring notes

Read before building the provider adapters.

## Structure

- Two adapters cover everything: `AnthropicSeat` (Anthropic SDK) and
  `OpenAICompatSeat` (plain fetch against any OpenAI-compatible endpoint —
  OpenCode Zen for GLM and GPT, OpenAI direct if ever needed). Shared prompt
  assembly in `prompt.ts`; only the transport differs.
- Seat specs are strings via `factory.ts` (`anthropic:claude-opus-5`,
  `opencode:glm-5.2`, `opencode:<gpt-model>`, `openai:<model>`) so lineups are
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

## Keys and transport

- Seats read API keys from environment variables only (`ANTHROPIC_API_KEY`,
  `OPENCODE_API_KEY`, `ANTHROPIC_MAPGEN_API_KEY`). Inject them at launch
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
- Same observation schema, same journal cap, same max tokens per call.

## Cost controls

- Log every call: prompt, response, token usage, latency. This is both the
  replay record and the cost ledger.
- Per-run token budget guard: abort past a configurable ceiling.
- Use low reasoning effort (or the provider equivalent) for routine ticks;
  effort level is itself an experimental variable worth sweeping.
- Estimated ~$2–20 per 100-tick 4-seat run depending on model tier; negotiate
  subrounds roughly double it. Parallel seeds share the prompt cache within a
  provider.

## Caching notes

- The rules prompt caches on Anthropic models (Opus 5 minimum cacheable prefix
  is 512 tokens). Haiku 4.5's minimum is 4096, so a ~2K rules prompt silently
  won't cache there — acceptable (Haiku input is cheap) or pad past the
  threshold.
