/**
 * Subscription version bookkeeping — NOT reactive UI state.
 *
 * The subscription payload (status / entitlements / banner) lives in the
 * TanStack Query cache (`useSubscriptionQuery`), and the trial / past-due
 * banner renders from that payload on SubscriptionScreen. All this module
 * holds is the highest `X-Subscription-Version` the axios interceptor has seen
 * on a response header — pure imperative bookkeeping read and written outside
 * React. Nothing subscribes to it, so it's a plain module singleton rather
 * than a Zustand store (which would only pretend to be reactive).
 */

/** Highest `subscription_version` seen on any response header so far. */
let lastSeenVersion: number | null = null;

/**
 * Record a version from a response header. Returns `true` only when it ADVANCED
 * past the last seen — the first version is adopted silently as a baseline (the
 * subscription query's own mount-fetch already supplies it), so the interceptor
 * refetches exactly once per real bump and dedupes duplicate/out-of-order
 * headers.
 */
export function observeSubscriptionVersion(version: number): boolean {
  if (lastSeenVersion === null) {
    lastSeenVersion = version;
    return false;
  }
  if (version <= lastSeenVersion) return false;
  lastSeenVersion = version;
  return true;
}

/** Reset at every session-end checkpoint (logout / mid-session auth-loss) so
 *  the next account on this device starts from a clean baseline instead of
 *  inheriting the previous account's last-seen version. */
export function resetSubscriptionFreshness(): void {
  lastSeenVersion = null;
}