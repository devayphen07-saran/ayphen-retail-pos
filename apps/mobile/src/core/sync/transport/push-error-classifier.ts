import axios from 'axios';

/**
 * Classifies a `pushDelta` failure as poison (the server gave a definitive,
 * non-retryable rejection for the WHOLE batch) vs. transport-transient
 * (offline, timeout, 5xx, or rate-limited — retrying later is exactly the
 * right response). Only a poison failure should count toward a mutation's
 * dead-letter cap (mutation-queue.repository.ts's MAX_ATTEMPTS_BEFORE_DEAD):
 * an extended offline period or a saturated server must never age an honest
 * queued write toward 'dead'.
 *
 * A batch-level poison rejection means the server's own request-body
 * validation (e.g. Zod) rejected the payload before touching any individual
 * mutation — a 4xx status OTHER than 429 (429 is rate-limiting, converted to
 * `RateLimitedError` upstream by `rethrowIfRateLimited` and so never reaches
 * here as a raw axios error anyway). No response at all (offline, DNS
 * failure, timeout) or a 5xx is the network's/server's fault, not the
 * mutation's, so it's transient.
 */
export function isPoisonPushError(err: unknown): boolean {
  if (!axios.isAxiosError(err) || !err.response) return false;
  const status = err.response.status;
  return status >= 400 && status < 500 && status !== 429;
}