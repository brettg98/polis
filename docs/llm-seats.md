# LLM seat wiring notes

Read before building the provider adapters.

## Structure

- Two adapters cover everything: `AnthropicSeat` (Anthropic SDK) and
  `ChatCompletionsSeat` (plain fetch against anything speaking
  `/chat/completions` — Z.ai direct, OpenAI direct, the OpenCode Zen gateway).
  The second is named for a protocol rather than a vendor, because it serves
  three and OpenAI is not the one it serves most. Shared prompt assembly in
  `prompt.ts`; only the transport differs.
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

That split is measured, not stylistic. Zen resells GLM 5.2 at Z.ai's own list
price ($1.40/$4.40), so it earns nothing on that model and caps the models that
consume the most. Its margin is not uniform, though — checked against OpenAI's
published rates, it resells `gpt-5.6-sol` at cost, `gpt-5.6-terra` at 1.25x, and
`gpt-5.6-luna` at 5x. "The gateway earns nothing on tokens" is true of GLM and
sol and false of the other two, so a route change moves cost figures as well as
reported usage. Across four attempted
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
  `ZAI_API_KEY`, `OPENCODE_API_KEY`, `OPENAI_API_KEY`, `MOONSHOT_API_KEY`,
  `ANTHROPIC_MAPGEN_API_KEY`). Inject them at launch from your secret manager of
  choice; values never touch disk or git.
- **Moonshot runs two platforms with separate balances.** `api.moonshot.ai` is
  the international one and is what `moonshot:` resolves to; `api.moonshot.cn` is
  a different account with its own credit that does not sync. A key from the
  wrong one authenticates against nothing here.
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
- **Comparable deliberation, measured — not an identical effort label.** Every
  seat used to get one `REASONING_EFFORT` constant. That rule was abandoned on
  2026-08-02 (ADR-006) because it does not survive contact with a second vendor:
  each provider calibrates its own ladder, so the same string bought ~750 output
  tokens per call on Anthropic and ~8,800 on Z.ai. `EFFORT` in `factory.ts` now
  carries a per-provider value, each one a calibration claim backed by a
  measurement rather than a preference.

  The property the benchmark holds instead is a bound on **measured output
  tokens**: no seat's mean may exceed another's by more than **3x**. Over a run
  that means per-seat mean output tokens per call **discarding ticks 1–20**,
  which are the opening transient rather than the steady state — output settles
  by roughly t20–40 and is flat afterwards, so a short run measures the wrong
  thing (ADR-006, 2026-08-02 amendment).

  **"Output tokens" is derived, not read from a field.** It is
  `total_tokens − prompt_tokens` where `total_tokens` exists, falling back to
  `output_tokens` / `completion_tokens` where it does not — the Anthropic
  Messages API has no `total_tokens`. Reading `completion_tokens` directly is
  wrong on at least one route: Google's OpenAI-compat endpoint keeps reasoning
  out of it, reporting 442 where the true figure is 2,627, so the seat looks
  more compliant the harder it thinks. Five of seven routes measured put
  reasoning inside the field and agree with the derivation exactly; one hides it
  in the total; the `opencode` gateway reports it nowhere and stays uncertifiable
  (ADR-006, 2026-08-04 third amendment, #33).

  Chosen at 3x because parity is not reachable — every GLM setting that gets near
  the Anthropic seats lands 1.4–2.4x *below* them, and Z.ai's ladder has nothing
  in between. A bound is enforceable and checkable; parity would just be the old
  claim with new wording.

  **The bound gates settings, not results.** A configuration whose predicted
  spread exceeds 3x is not run. A completed run that breaches is published as it
  came out with the deviation disclosed, following ADR-005 — re-running
  non-deterministic models yields a second sample rather than a correction.

  **The bound as it currently stands**, mean ± sd over the same two ticks, at
  each seat's configured setting:

  | seat | setting | quiet | crisis |
  |---|---|---|---|
  | Opus 5 | `low` | 897 ± 78 | 1,563 ± 340 |
  | Sonnet 5 | `low` | 753 ± 89 | 1,199 ± 324 |
  | GPT 5.6 Terra | `low` | 567 ± 127 | 899 ± 356 |
  | GLM 5.2 | `none` | 591 ± 87 | 863 ± 168 |

  Widest gap: **1.58x** on the quiet tick, **1.81x** on the crisis one. Every
  seat is measured; nothing in this table is an assumption.

  The one route that cannot be brought under the bound is the `opencode`
  gateway, and not because nobody has measured it. It reports
  `reasoning_tokens: 0` for the GPT route while billing for them, so the
  quantity the bound is defined on is under-reported there by construction. A
  seat that has to satisfy this rule belongs on a direct route.

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

Equalising it cut GLM's latency and cost sharply on the smoke tests it was
measured against, and the figure recorded here at the time — ~2,200 output tokens
per call — came from those. It does not survive a tournament tick, and the
equalisation itself does not survive contact with Z.ai.

### What the providers actually do with the parameter (measured 2026-08-02)

`scripts/effort-probe.ts` replays two real tournament ticks (Kilnspire at t44 and
t47, rebuilt from `runs/t2-full/chronicle-rot0.json`) at several effort levels.
Output tokens per call, reasoning included in both providers' counts:

| model | observation | none | minimal | low | high | max |
|---|---|---|---|---|---|---|
| `claude-opus-5` | quiet | — | — | 996 | 3,186 | 15,771 |
| `claude-opus-5` | crisis | — | — | 1,534 | 4,622 | 16,000 ✗ |
| `claude-sonnet-5` | quiet | — | — | 745 | 1,986 | 16,000 ✗ |
| `claude-sonnet-5` | crisis | — | — | 1,224 | 5,761 | 16,000 ✗ |
| `glm-5.2` | quiet | 524 | 547 | 8,771 | 5,733 | 9,606 |
| `glm-5.2` | crisis | 877 | 563 | 11,814 | 10,627 | 14,330 |

✗ = exhausted the 16,000-token ceiling and returned no usable action.

Three things follow.

**Anthropic honours it.** The ladder is monotonic and steep on both models and
both ticks. Those seats really were capped.

**Z.ai does not deliver a low setting.** GLM at `low` spends 8,771–11,814 output
tokens where Opus at `low` spends 996–1,534 — six to nine times, at the value the
fairness rule takes for the floor. Z.ai's reference says `low` and `medium` are
remapped to `high` on glm-5.2; measured, `low` ran *above* `high` in both ticks
(by 53% and 11%), which is one call per cell against a model emitting thousands of
reasoning tokens and so cannot settle whether the reference is wrong. It does not
need to be settled. Either way `low` is not a floor on this route, and the seat
sees no error because the parameter is accepted rather than rejected.

**`max` is out of reach at the current ceiling.** Three of four Anthropic `max`
calls hit 16,000 tokens and returned nothing parseable — the same failure GLM hit
at t74 of rotation 1, which the engine records as a defection the city never
chose. Sweeping `max` means raising the output ceiling first, and the ceiling is
itself one of the equalised properties.

### Turning GLM's thinking off, three ways

Z.ai offers three settings documented as skipping thinking: `reasoning_effort`
of `none` or `minimal`, and a separate `thinking: {"type": "disabled"}` field
that is not a rung on the effort ladder at all. All three were measured on the
same two ticks:

Five calls per cell, mean ± sd. The Anthropic seats at `low` are the target the
GLM settings are being matched against, so they carry the same repeat count:

| seat | quiet | crisis | slope | t (tick response) |
|---|---|---|---|---|
| Opus 5 at `low` | 877 ± 68 | 1,568 ± 380 | +79% | 4.00 |
| Sonnet 5 at `low` | 754 ± 99 | 1,194 ± 362 | +58% | 2.62 |
| GLM `none` | 604 ± 91 | 860 ± 187 | +42% | 2.75 |
| GLM `disabled` | 577 ± 78 | 685 ± 106 | +19% | 1.83 |
| GLM `minimal` | 626 ± 78 | 652 ± 128 | +4% | 0.39 |

**No GLM setting actually matches.** Every off-switch sits below both Anthropic
seats on both ticks, and mostly by a comfortable margin (Welch t from -1.83 to
-6.47 across the six setting-by-seat pairs). What is on offer is not parity but a
much smaller miss: GLM at `low` runs 10.0x Opus on the quiet tick and 7.5x on the
crisis one, where GLM at `none` runs 1.45x and 1.82x under the widest seat. That
is the trade — from an order of magnitude over to under a factor of two under.

**The three off-switches are indistinguishable by level.** On the quiet tick
every pairwise Welch |t| ≤ 1.0; on the crisis tick nothing clears significance
either (`none` vs `minimal` t=2.04, `none` vs `disabled` t=1.82). Run-to-run
spread is 12–22% of the mean. An earlier reading of single samples treated the
`none`/`minimal` gap as real; it does not survive repeats.

**They separate on the response to tick difficulty, and that is the useful axis.**
Both Anthropic seats do materially more work on the harder tick (t=4.00 and
t=2.62). `none` does too (t=2.75) at a slope in the same regime. `minimal` does
not (t=0.39, flat on two independent passes), and `disabled` is ambiguous
(t=1.83). A seat pinned flat is not playing the same game even at a matching
token count, and the crisis ticks are where the behaviour this benchmark measures
lives.

On that basis `none` is the closest available match: nearest on the crisis tick
and the only off-switch whose difficulty response looks like the Anthropic seats'.

One thing these numbers cannot settle: `output_tokens` does not separate
reasoning from action text on the Z.ai route, so whether `none`'s extra
crisis-tick output is thinking or a longer journal is unresolved.

The consequence for the fairness rule is in
`ADR-005-reasoning-effort-and-tournament-1.md`.

## Cost controls

- Log every call: prompt, response, token usage, latency. This is both the
  replay record and the cost ledger.
- Per-run token budget guard: abort past a configurable ceiling.
- Reasoning effort is `low` for every seat (see the fairness rules above), which
  Anthropic honours and Z.ai does not. It is still the single biggest cost lever:
  GLM's spend is almost entirely reasoning tokens, and on the probe above GLM at
  `minimal` costs a sixteenth of GLM at `low`. Effort remains an experimental
  variable worth sweeping — but sweep it for all seats at once, never one
  provider at a time, and sweep against measured output tokens rather than the
  label, because the label does not mean the same thing to two vendors.
- Estimated ~$2–20 per 100-tick 4-seat run depending on model tier; negotiate
  subrounds roughly double it. Parallel seeds share the prompt cache within a
  provider.

## Caching notes

- The rules prompt caches on Anthropic models (Opus 5 minimum cacheable prefix
  is 512 tokens). Haiku 4.5's minimum is 4096, so a ~2K rules prompt silently
  won't cache there — acceptable (Haiku input is cheap) or pad past the
  threshold.
