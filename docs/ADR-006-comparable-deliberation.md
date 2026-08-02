# ADR-006: What "same reasoning effort" is replaced by

Date: 2026-08-02
Status: accepted
Supersedes the open question left in ADR-005's 2026-08-02 addendum.

## Context

`docs/llm-seats.md` required identical reasoning effort across seats from the
day the seat layer existed. ADR-005 recorded that the rule was documented but
unenforced during tournament 1, and that the constant was equalised afterwards.
That equalisation was assumed to fix it.

Issue #21 measured whether it had. It had not, on half the lineup. Replaying two
real tournament ticks at five calls per cell, at an identical `low`:

| seat | quiet tick | crisis tick |
|---|---|---|
| Opus 5 | 897 ± 78 | 1,563 ± 340 |
| Sonnet 5 | 753 ± 89 | 1,199 ± 324 |
| GLM 5.2 | 8,771 | 11,814 |

Anthropic honours the parameter — `low`, `high` and `max` are monotonic and
steep. Z.ai accepts it and does not deliver a low setting; its reference states
that `low` and `medium` are mapped onto `high` for glm-5.2. Because the value is
accepted rather than rejected, the compat adapter's drop path never fires and no
log line records a problem. It was caught on an invoice.

**Tournaments 1 and 2 both ran under this, in the same direction, and GLM won
both.**

The rule cannot be repaired by sending a different string. Each vendor defines
and calibrates its own ladder, and the ladders do not have comparable rungs. On
GLM the reachable states are effectively "thinking off" (591–863 output tokens),
`high` (5,733–10,627) and `max` (9,606–14,330). There is nothing between the
first and the second, and the Anthropic seats at `low` sit in that gap.

## Decision

**The rule "identical reasoning effort across seats" is withdrawn. It is replaced
by a bound on measured output tokens: no seat's mean may exceed another's by more
than 3x on the same observation.** (The metric is stated precisely in the
2026-08-02 amendment below; "the same observation" was written against a single
probe tick and does not define itself over a run.)

`REASONING_EFFORT`, one constant for every seat, becomes `EFFORT`, a per-provider
map in `src/llm/factory.ts`. Each entry is a calibration claim about that
provider, backed by a measurement, and entries that have never been measured say
so in the code.

**The GLM route sends `none`.** Of the three settings Z.ai documents as skipping
thinking, the three are indistinguishable by token count (every pairwise Welch
comparison fails significance at n=5), but they differ in how they respond to a
harder tick: `none` does more work on the crisis observation (+46%, t=2.75),
`minimal` is flat (+4%, t=0.39) across two independent passes, and
`thinking: {"type": "disabled"}` is ambiguous (+22%, t=1.83). The Anthropic seats
respond at +74% and +59%. A seat pinned flat is not playing the same game at any
token count, and the crisis ticks are where the measured behaviour lives, so the
choice was made on that axis rather than on volume.

## Why a bound, and why 3x

A bound is enforceable from our side; parity is not. Setting the target at
parity would restate the old claim in new words and be false in the same way.

3x is chosen against what is reachable rather than what is tidy. With GLM on
`none` the widest cross-seat gap is 1.45x on a quiet tick and 1.82x on a crisis
one, so 3x holds with room for the run-to-run variance actually observed —
Anthropic's own crisis-tick spread is 22–27% of its mean. A tighter bound would
fail on noise; a looser one would have admitted the 7.5–10x that produced this
ADR.

This is deliberately a weaker property than the one it replaces. That is the
point: it is weaker and true, where the old rule was stronger and false.

## Consequences

- **Tournament 3 is not comparable to 1 or 2 on the effort axis.** Both earlier
  runs had GLM deliberating roughly ten times the Anthropic seats; this changes
  it. That is a third reason those runs do not line up, alongside the build
  mechanic and the tournament-1 disclosure already in ADR-005.
- **GLM is not level with the Anthropic seats, it is under them** — 591–863
  output tokens against 753–1,563. The asymmetry is smaller and points the other
  way. Any writeup comparing GLM to the Anthropic models has to say so, and the
  same disclosure discipline ADR-005 established applies.
- **The bound has to be checked, not assumed.** Before a tournament runs, and
  again from the call logs afterwards. A provider can change its mapping without
  telling us, and the failure is silent by construction.
- ~~`opencode` and `openai` entries remain unverified.~~ Resolved 2026-08-02, see
  the addendum below.
- GLM's cost and latency drop sharply as a side effect — roughly a tenth the
  output tokens and 113s down to about 10s per call. Cost figures from
  tournaments 1 and 2 do not predict future runs.

## Rejected

**Raise every seat to `high` instead.** Would put Opus at 3,186, Sonnet at 1,986
and GLM at 5,733 on a quiet tick — a 2.9x spread, inside the bound, with nobody's
reasoning switched off and every seat still adapting to tick difficulty. Rejected
on cost and headroom: Anthropic output rises 2–4x, and GLM's 10,627 on a crisis
tick sits close enough to the 16,000 ceiling to risk the exhaustion failure that
cost a tick in rotation 1. Worth revisiting if the ceiling moves.

**Keep the identical-label rule and disclose the gap.** This is what tournament 2
did, unintentionally. The gap is an order of magnitude; disclosing it does not
make the comparison usable, and the disclosure would have to be repeated on every
number the run produces.

**Drop GLM.** Removes the discrepancy along with the winner of both tournaments
and the only non-Anthropic model with a completed cross-seat record.

## Addendum, 2026-08-02: the fourth seat, and one route that cannot comply

The decision above left `opencode` and `openai` as unmeasured entries sitting in
a structure that presents itself as measured. Terra has since been moved to the
direct OpenAI route (issue #18) and probed on the same two ticks, five calls per
cell:

| Terra setting | quiet | crisis | slope | fleet spread |
|---|---|---|---|---|
| `none` | 323 ± 35 | 353 ± 31 | +9% | 2.78x / **4.43x** |
| `low` | 567 ± 127 | 899 ± 356 | +59% | 1.58x / 1.81x |
| `medium` | 694 ± 110 | 1,075 ± 465 | +55% | 1.52x / 1.81x |

`none` fails the bound on the crisis observation, and fails it in the
characteristic way: it flattens the seat to a +9% response where every other
seat gives +46% to +74%. That is the same defect that ruled out `minimal` for
GLM — a seat that does no extra work on a harder tick is cheap for the wrong
reason.

`low` and `medium` both comply. `low` is kept: it matches Sonnet's slope exactly
and costs less. **The entry was already `low`; what changed is that it is now
evidence rather than a guess**, which is the whole point of the map.

**`opencode` is a different case and will not be resolved by measuring.** The
gateway reports `reasoning_tokens: 0` for the GPT route while billing for them,
so the quantity this ADR's bound is defined on is under-reported there by
construction. No value of the effort parameter fixes that. A seat that has to
satisfy this rule belongs on a direct provider route, which is now the documented
default for lineups.

With that, every seat in the standard lineup is measured and the bound holds at
1.58x on a quiet tick and 1.81x on a crisis one — comfortably inside 3x, with the
margin absorbed by run-to-run variance rather than by the choice of settings.

## Amendment, 2026-08-02: what the bound measures, and what a breach means

The decision above set the bound "on the same observation." That phrasing came
from the probe, which replays one frozen tick. A tournament has a hundred
observations, so as written it did not pick out anything — and the same 25-tick
test run reads 1.66x, 1.92x or worse depending on which reading is taken. A rule
with an ambiguous metric gets interpreted after the fact by whoever is holding a
number they already have.

### The metric

**Per-seat mean output tokens per call across a run, discarding ticks 1–20.**
The bound holds when no seat's figure exceeds another's by more than 3x.

Ticks 1–20 are discarded because they are not the steady state. Measured across
tournament 2's four rotations of 100 ticks:

| seat | t1–20 | t21–40 | t41–60 | t61–80 | t81–100 |
|---|---|---|---|---|---|
| Opus 5 | 1,012 | 1,082 | 1,037 | 985 | 853 |
| Sonnet 5 | 880 | 833 | 863 | 1,024 | 861 |
| Terra | 789 | 719 | 692 | 676 | 721 |
| GLM 5.2 | 6,107 | 6,603 | 7,186 | 6,883 | 5,670 |

No seat grows over a full run. Output per call settles by roughly t20–40 and is
flat or slightly declining after that — the journal cap and a stabilising ledger,
probably, with late decline partly from cities dying and simplifying the
decision. (Read each row's shape rather than the cross-seat gaps: GLM's figures
predate this ADR and Terra's are gateway-underreported. Opus and Sonnet are
directly comparable to the current configuration, and their per-window ratio
stays within 0.96–1.30 across the full run.)

A consequence worth stating because it is easy to get wrong: **a short run
measures the transient, not the steady state.** A 25-tick run's token profile is
not a preview of a 100-tick run's. Any check against this bound needs enough
ticks past the opening window to be meaningful.

### What a breach means

**The bound gates settings. It does not gate results.**

Before a run, each seat's setting is chosen against a measurement (the probe),
and a configuration whose predicted spread exceeds 3x is not run. That is the
enforceable half, and it is where the rule does its work.

After a run, the bound is measured again from the call logs and reported. A
completed run that breaches is **published as it came out, with the deviation
disclosed next to the results** — not discarded, not re-run.

This follows ADR-005's precedent rather than inventing a new one. Re-running
non-deterministic models produces a second sample, not a correction, and a
published result with a clear account of its flaw is a better artifact than a
quietly replaced table. It also keeps the project honest about what it can
enforce: we choose settings, providers choose behaviour, and a rule that claimed
to govern the second would be the old rule again under a new name.

Rejected: **aborting mid-run on breach** (needs live checking rather than
post-run analysis, and discards a partial run that may still be worth reading);
**re-tuning and re-running** (ADR-005's argument applies unchanged); **disclosure
with no pre-run gate** (gives up the half that actually works).

## Revisit when

The output ceiling changes, a provider's documented mapping changes, or a seat's
measured band moves — any of which can break the bound silently. Also if the
`opencode` route is ever measured, since that entry is currently an assumption
sitting in a structure that presents itself as measured.
