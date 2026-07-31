// Acceptance cases for the transient-error retry delay (issue #13).
// `npm run verify:backoff`
//
// Two things are being pinned. First, that a transient failure waits and a
// model-authored one does not: waiting on a malformed action buys nothing and
// costs the tick wall time, while retrying a rate limit inside the same second
// burns the seat's whole retry budget and passes the tick — which the engine
// records as a defection the city never chose.
//
// Second, that both adapters share one policy. The one-retry rule is a
// fairness invariant (docs/llm-seats.md); a longer grace period for one vendor
// is an advantage in a benchmark whose point is the comparison.
//
// No models, no keys, no network.
import fs from 'node:fs';
import path from 'node:path';
import {
  MAX_RETRY_DELAY_MS,
  ProviderError,
  TRANSIENT_RETRY_DELAY_MS,
  parseRetryAfter,
  retryDelayMs,
} from '../src/llm/backoff';

let failures = 0;
function check(label: string, actual: number | boolean, expected: number | boolean, tolerance = 0): void {
  const ok =
    typeof actual === 'boolean' || typeof expected === 'boolean'
      ? actual === expected
      : Math.abs(actual - expected) <= tolerance;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: got ${actual}, want ${expected}`);
  if (!ok) failures++;
}

console.log('\n=== Retry delay on transient provider errors (issue #13) ===\n');

console.log('Case 1: the failures that stalled tournament 2 now wait');
check('HTTP 429 with no Retry-After', retryDelayMs(new ProviderError('HTTP 429: rate limit', 429)), TRANSIENT_RETRY_DELAY_MS);
check('HTTP 503', retryDelayMs(new ProviderError('HTTP 503: bad gateway', 503)), TRANSIENT_RETRY_DELAY_MS);
check('a timeout with no status', retryDelayMs(new Error('The operation was aborted due to timeout')), TRANSIENT_RETRY_DELAY_MS);
check('a dropped connection', retryDelayMs(new Error('fetch failed: ECONNRESET')), TRANSIENT_RETRY_DELAY_MS);

console.log('\nCase 2: model-authored failures retry immediately');
check('an invalid action', retryDelayMs(new Error('invalid action: deliveries[0].amount is not a number')), 0);
check('unparseable content', retryDelayMs(new Error('unparseable content (finish_reason: length)')), 0);
check('HTTP 400', retryDelayMs(new ProviderError('HTTP 400: bad request', 400)), 0);
check('HTTP 401', retryDelayMs(new ProviderError('HTTP 401: unauthorized', 401)), 0);

console.log('\nCase 3: Retry-After is honoured, and bounded');
check('delta-seconds', retryDelayMs(new ProviderError('HTTP 429', 429, 2_000)), 2_000);
check('a wait past the ceiling is clamped', retryDelayMs(new ProviderError('HTTP 429', 429, 600_000)), MAX_RETRY_DELAY_MS);
check('parsed from a header value', parseRetryAfter('3') ?? -1, 3_000);
check('an HTTP-date header parses', (parseRetryAfter(new Date(Date.now() + 4_000).toUTCString()) ?? -1) > 2_000, true);
check('a junk header is ignored', parseRetryAfter('soon') === undefined, true);
// A provider that sends Retry-After on a 400 is not describing a transient
// fault, and honouring it would stall the tick for nothing.
check('Retry-After on a 400 is not honoured', retryDelayMs(new ProviderError('HTTP 400', 400, 30_000)), 0);

console.log('\nCase 4: the ceiling is smaller than the per-call timeout');
// Seats run in parallel and the tick waits for the slowest, so the wait has to
// stay well inside the 300s call timeout or one sick provider stalls the world.
check('ceiling under 300s', MAX_RETRY_DELAY_MS < 300_000, true);

console.log('\nCase 5: both adapters use the same policy');
// Asserted against the source: the fairness rule is that the delay cannot
// differ by provider, and the way that breaks is someone hand-rolling a wait
// in one adapter.
const llmDir = path.join(import.meta.dirname, '..', 'src', 'llm');
for (const file of ['anthropicSeat.ts', 'openaiCompatSeat.ts']) {
  const src = fs.readFileSync(path.join(llmDir, file), 'utf8');
  check(`${file} calls the shared helper`, /retryDelayMs\(/.test(src), true);
  check(`${file} has no hand-rolled wait`, /setTimeout\(/.test(src), false);
}

console.log(failures ? `\n${failures} check(s) failed.\n` : '\nAll cases passed.\n');
process.exit(failures ? 1 : 0);
