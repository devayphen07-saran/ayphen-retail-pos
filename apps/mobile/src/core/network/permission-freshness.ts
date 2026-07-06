/**
 * Permissions version bookkeeping — NOT reactive UI state.
 *
 * Mirrors subscription-freshness.ts exactly, but for `X-Permissions-Version`.
 * The cached `PermissionSnapshot` (authStore.snapshot) is what's actually used
 * for local UX gating (usePermission.ts); this module only tracks the highest
 * version the axios interceptor has seen on a response header so it can
 * trigger exactly one bootstrap refetch per real bump, not a reactive store.
 */

/** Highest `permissions_version` seen on any response header so far. */
let lastSeenVersion: number | null = null;

/**
 * Record a version from a response header. Returns `true` only when it
 * ADVANCED past the last seen — the first version is adopted silently as a
 * baseline (bootstrap/login/refresh already supplied the matching snapshot),
 * so the interceptor refetches exactly once per real bump and dedupes
 * duplicate/out-of-order headers.
 */
export function observePermissionsVersion(version: number): boolean {
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
export function resetPermissionFreshness(): void {
  lastSeenVersion = null;
}
