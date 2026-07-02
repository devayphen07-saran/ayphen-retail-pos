/**
 * Versioned subscription cache keys (subscription §19). The snapshot lives under
 * a version-pinned key; a tiny pointer key holds the current version. On a
 * version bump the writer advances the pointer, so the old snapshot key becomes
 * unreferenced and expires by TTL — no explicit DEL, no delete-vs-write race.
 *
 * Shared by SubscriptionStatusGuard (reader) and SubscriptionService (writer) so
 * the scheme is defined in exactly one place.
 */

/** Points at the account's current subscription_version. */
export const subVersionPointerKey = (accountId: string) => `sub:ver:${accountId}`;

/** The version-pinned snapshot. */
export const subSnapshotKey = (accountId: string, version: number) =>
  `sub:${accountId}:v${version}`;

/** Snapshot TTL and pointer TTL (subscription §19: 5 min). */
export const SUB_CACHE_TTL_SECONDS = 300;
