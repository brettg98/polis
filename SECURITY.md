# Security

## Reporting a vulnerability

Use GitHub's private vulnerability reporting: the **Security** tab →
**Report a vulnerability**. It keeps the report private until there's a fix.

If that option isn't available, email **security@curiousorbit.com** with
"POLIS" in the subject.

Please don't open a public issue for anything exploitable.

This is a solo research project, not a product with an on-call rotation. Expect
an acknowledgement within a week. If something is actively being exploited, say
so in the report title.

## Threat model

POLIS is a static browser app plus a set of local scripts. There is no server,
no account system, no user data, and no session to steal. Two trust boundaries
are worth knowing about.

### Scenario files are untrusted input

Scenario files in `scenarios/` are LLM-authored (`npm run genmap`) and designed
to be shared between people running the sim. A scenario controls city names,
colors, the world seed, and shock definitions, all of which reach the DOM.

Everything derived from a scenario is escaped before it reaches `innerHTML`
(`src/render/hud.ts`), and CSS values are pattern-checked rather than
HTML-escaped, because escaping alone does not stop a value breaking out of a CSS
declaration. If you add a rendering path, keep that property. Running a scenario
you did not generate is otherwise equivalent to opening any untrusted file.

### Model output is untrusted input

Seat actions come back from external model APIs and are validated in
`src/llm/validate.ts` before the engine sees them, regardless of whether the
provider claimed to enforce a schema. Gateways can and do silently ignore
structured-output directives, so client-side validation is the only guarantee.

Validation is also the fairness layer: identical rules for every provider, one
retry with the errors fed back, then the seat passes the tick. Do not weaken it
for one provider without weakening it for all of them.

## Credentials

API keys are read from environment variables only (`ANTHROPIC_API_KEY`,
`OPENCODE_API_KEY`, `ANTHROPIC_MAPGEN_API_KEY`). They are never committed, never
written to disk by this project, and never reach the browser. The browser sim
makes no provider calls; it runs scripted seats locally.

`runs/` is gitignored. It holds raw model call logs, which are the cost ledger
and the replay record. Review before sharing.

## Dependencies

`npm audit --omit=dev` should report zero vulnerabilities. Development-only
findings against the Vite dev server are still worth fixing, since contributors
run it.
