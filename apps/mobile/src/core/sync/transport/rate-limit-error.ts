import axios from 'axios';

/** Fallback wait when the server sends a 429 with no (or an unparseable)
 *  `Retry-After` header — shouldn't happen given the backend's ThrottlerGuard
 *  always sets it (`setHeaders: true`), but a transport-layer assumption about
 *  a header's presence is exactly the kind of thing that should degrade
 *  gracefully instead of crashing on `undefined`. */
const DEFAULT_RETRY_AFTER_MS = 30_000;

/**
 * Thrown by every `sync-transport.ts` call on a 429 — the ONE signal the
 * pull/push loops and the scheduler need to stop hammering the backend and
 * wait the exact duration the server asked for, instead of treating it like
 * any other transient network error (which triggers an immediate blind retry
 * inside a tight `while` loop today).
 */
export class RateLimitedError extends Error {
  constructor(public readonly retryAfterMs: number) {
    super(`Rate limited — retry after ${retryAfterMs}ms`);
    this.name = 'RateLimitedError';
  }
}

/** Parses the backend's `Retry-After` header (seconds, per `@nestjs/throttler`'s
 *  `ThrottlerGuard` default) into ms. Falls back to a sane default if the
 *  header is missing or not a valid number — never throws on a malformed value. */
function parseRetryAfterMs(headerValue: unknown): number {
  const seconds = Number(headerValue);
  if (!Number.isFinite(seconds) || seconds < 0) return DEFAULT_RETRY_AFTER_MS;
  return seconds * 1000;
}

/**
 * Rethrows a 429 axios error as `RateLimitedError`; every other error passes
 * through unchanged. Every `sync-transport.ts` call site should route its
 * catch through this so the classification is defined in exactly one place.
 */
export function rethrowIfRateLimited(err: unknown): never {
  if (axios.isAxiosError(err) && err.response?.status === 429) {
    throw new RateLimitedError(parseRetryAfterMs(err.response.headers?.['retry-after']));
  }
  throw err;
}
