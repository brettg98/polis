// Shared retry timing for every seat adapter.
//
// The one-retry rule is a fairness invariant (docs/llm-seats.md): one retry,
// then the seat passes the tick. This module changes only the *timing* of that
// second attempt, never the count, and it lives in one file precisely so the
// delay cannot drift between providers. A longer grace period for one vendor
// is an advantage in a benchmark whose whole point is the comparison.
//
// Why the delay matters more than the lost call: a passed tick ships nothing,
// and the engine records that as a defection by a city that never chose one.
// Other seats read it, retaliate, and write it into their journals, which are
// permanent. Annotating it as mechanical afterwards fixes the bookkeeping and
// not the behaviour (issue #13).

/** Pause before the second attempt when the provider looks briefly unwell. */
export const TRANSIENT_RETRY_DELAY_MS = 5_000;

/**
 * Ceiling on any single wait, including a provider-supplied `Retry-After`.
 * Seats run in parallel and the tick waits for the slowest, so an unbounded
 * wait stalls the whole world rather than one city.
 */
export const MAX_RETRY_DELAY_MS = 20_000;

/** A provider request that failed with a status code we can reason about. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

/**
 * `Retry-After` is either delta-seconds or an HTTP date (RFC 9110 §10.2.3).
 * Returns undefined for anything unparseable rather than guessing.
 */
export function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const when = Date.parse(value);
  if (Number.isNaN(when)) return undefined;
  return Math.max(0, when - Date.now());
}

/** Read `Retry-After` off either a fetch `Headers` or a plain object. */
export function retryAfterFrom(headers: unknown): number | undefined {
  if (!headers) return undefined;
  const get = (headers as { get?: (name: string) => string | null }).get;
  if (typeof get === 'function') return parseRetryAfter(get.call(headers, 'retry-after'));
  const bag = headers as Record<string, unknown>;
  const raw = bag['retry-after'] ?? bag['Retry-After'];
  return typeof raw === 'string' ? parseRetryAfter(raw) : undefined;
}

const TRANSIENT_MESSAGE = /\b(429|timeout|timed out|aborted|abort|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|network)\b/i;

/**
 * How long to wait before the retry, or 0 to retry immediately.
 *
 * Transient means the provider might succeed on a second attempt without
 * anything changing: rate limits, server faults, timeouts, dropped
 * connections. A malformed or invalid action is not transient — the model
 * needs the validation errors fed back, and waiting only wastes wall time.
 */
export function retryDelayMs(err: unknown): number {
  const status = (err as { status?: unknown }).status;
  const code = typeof status === 'number' ? status : undefined;

  const supplied =
    (err as ProviderError).retryAfterMs ?? retryAfterFrom((err as { headers?: unknown }).headers);
  if (supplied !== undefined && (code === undefined || code === 429 || code >= 500)) {
    return Math.min(supplied, MAX_RETRY_DELAY_MS);
  }

  if (code === 429 || (code !== undefined && code >= 500)) return TRANSIENT_RETRY_DELAY_MS;
  if (code !== undefined) return 0; // 4xx other than 429: waiting changes nothing

  return TRANSIENT_MESSAGE.test(String((err as Error)?.message ?? err)) ? TRANSIENT_RETRY_DELAY_MS : 0;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
