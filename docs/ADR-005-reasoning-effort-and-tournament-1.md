# ADR-005: Reasoning effort, and what tournament 1's results mean

Date: 2026-07-31
Status: accepted

## Context

Fairness across providers is the reason this benchmark exists. If the seats are
not playing under the same rules, the comparison measures the rules.

`docs/llm-seats.md` has required identical reasoning effort across seats since
the seat layer was written. On 2026-07-30 that rule turned out to be documented
but unenforced. Only the Anthropic adapter ever sent the parameter; the
OpenAI-compatible adapter sent nothing, so every other provider ran at its own
default:

| seat | sent | actually ran at |
|---|---|---|
| Opus, Sonnet | `effort: 'low'` | low |
| GPT 5.6 Terra | nothing | medium (the documented GPT-5.6 default) |
| GLM 5.2 | nothing | near-maximum |

The size of the gap is not marginal. On identical prompts `glm-5.2` produced
6,122 output tokens at its default against 1,078 at `low`, 93% of the former
being reasoning. In a live run it sat at 10,000–14,500 tokens per call against
the 16,000 ceiling and eventually exhausted it mid-tick, returning empty content
and passing the tick.

Tournament 1 ran under this asymmetry, and GLM won it. The published table has
GLM first on average final population (150, against Opus 137, Terra 130, Sonnet
99) while it was deliberating several times longer per call than the Anthropic
seats were permitted to.

The constant was equalised on 2026-07-30 (`a4bfd5c`). That fixes every run from
here. It does not settle what the already-published result means, which is what
this ADR decides.

## Decision

**Tournament 1's results stand as published, with the asymmetry disclosed
wherever the results are presented.**

The claim the run supports is narrower than "GLM plays this game best". It is:
under these rules, on this world, with each model at its provider's default
reasoning effort except the two Anthropic seats which were capped at `low`, the
final standings were these. That is still a result. It is not a clean
model-versus-model comparison on the effort axis, and it must not be presented
as one.

Disclosure is not satisfied by the fact being recorded somewhere in the repo. It
has to appear where the results appear: the README's results table and Fairness
section, the published highlights page, and the writeup.

**Going forward, reasoning effort is equalised and swept for all seats at once
or not at all.** Effort is a legitimate experimental variable — it is also the
single biggest cost lever measured here, having cut a run's spend by ~70% and
its wall time by ~5x. Varying it for one provider at a time is what produced
this problem.

## Consequences

- The tournament-1 headline needs a qualifier attached to it permanently, in the
  repo and in the writeup. A number that travels without its caveat (a chart
  screenshotted to social media, for instance) is the failure mode to design
  against, which is why the caveat belongs next to the table rather than in a
  footnote.
- Tournament 2 is already not comparable to tournament 1, because building
  changes the available actions and the rules prompt. Effort is now a second
  reason. Nothing is lost by this that was not already lost.
- The v0.1.0 tag remains the trade-only ruleset those results came from, and it
  still has the unenforced effort behaviour in it. That is correct: the tag
  should reproduce what was played, not what should have been played.
- Cost and latency figures published from tournament 1 describe GLM at
  near-maximum effort and are not predictive of the current configuration.

## Rejected

**Re-run the trade-only ruleset at equal effort.** The v0.1.0 rules are
retrievable and the seat layer ports in cleanly; a partial re-run was started
and reached tick 50 of rotation 0 before being stopped. Rejected because it buys
less than it costs. A full re-run is four rotations of 100 ticks and real money,
the models are non-deterministic so it produces a second sample rather than a
correction, and the finding it would protect — that the winner was thinking
longer — is more interesting stated than erased. The published result plus a
clear account of its flaw is a better artifact than a quietly replaced table.

**Drop tournament 1.** Discards the only completed cross-vendor run for a defect
that is disclosable. It would also leave the writeup with no results at all
until tournament 2 finishes.

## Revisit when

Reasoning effort is deliberately swept as a variable across all seats, which
would produce the clean comparison this run cannot support, and would supersede
the disclosure rather than repeat it.
