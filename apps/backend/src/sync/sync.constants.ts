/**
 * Every sync-engine tunable in one place (sync-engine.md §22 S-10). Encode
 * RELATIONSHIPS, not magic numbers — the tombstone-retention/horizon inversion
 * (S-22: retention < horizon → silently resurrected rows) happened because the
 * two constants lived in different files with no encoded dependency.
 */

// ─── Cursor horizon & retention (§4/§8/§19) ──────────────────────────────────

/** A cursor whose `ia` (issued-at, re-minted every poll) is older than this → 410. */
export const SYNC_HORIZON_DAYS = 180;

/** How far tombstone retention must EXCEED the horizon (BR-SYNC-013). */
export const TOMBSTONE_RETENTION_BUFFER_DAYS = 15;

/**
 * Invariant: any cursor that passes the horizon check can still find every
 * tombstone it needs. Retention is DERIVED, never set independently.
 */
export const TOMBSTONE_RETENTION_DAYS =
  SYNC_HORIZON_DAYS + TOMBSTONE_RETENTION_BUFFER_DAYS;

export const SYNC_HORIZON_MS = SYNC_HORIZON_DAYS * 24 * 60 * 60 * 1000;

// ─── Page sizes (§2) ─────────────────────────────────────────────────────────

/** Steady-state delta page — shared fairly across entities. */
export const DELTA_PAGE_SIZE = 200;

/** Per-entity floor so one entity's backlog never starves to ~10 rows/poll (S-11). */
export const PER_ENTITY_FLOOR = 20;

/** Cold-start bulk-dump page — the page size, not parallelism, is the cold-start lever (S-27). */
export const INITIAL_PAGE_SIZE = 1000;

// ─── Push limits (§9) ────────────────────────────────────────────────────────

export const MAX_MUTATIONS_PER_BATCH = 100;

/** Per-mutation payload cap (S-36) — a 500-line B2B order must be split client-side. */
export const MAX_MUTATION_PAYLOAD_BYTES = 64 * 1024;

// ─── Idempotency TTLs (§10) ──────────────────────────────────────────────────

/**
 * Applied/rejected results must outlive the client DLQ's max dwell (S-35) —
 * a DLQ'd sale retried after its idempotency row is purged re-executes as a
 * double sale. 45 d > max(refresh-token 30 d, DLQ dwell 30 d) + margin.
 */
export const IDEMPOTENCY_TTL_DAYS = 45;
export const IDEMPOTENCY_TTL_MS = IDEMPOTENCY_TTL_DAYS * 24 * 60 * 60 * 1000;

/** Conflicts expire fast so a post-merge resubmit isn't wrongly deduped as stale. */
export const IDEMPOTENCY_CONFLICT_TTL_MS = 5 * 60 * 1000;

/** Concurrent-duplicate race: loser polls the winner's row, then 503s (§10). */
export const IDEMPOTENCY_RACE_POLL_INTERVAL_MS = 200;
export const IDEMPOTENCY_RACE_POLL_TIMEOUT_MS = 3_000;

// ─── Point-in-time entitlement (§12) ─────────────────────────────────────────

/** Future skew beyond this is CLAMPED to server-now at preflight (S-24) — never reject honest revenue. */
export const FUTURE_SKEW_TOLERANCE_MS = 5 * 60 * 1000;

/** Cap on how far back any grace-honored mutation may reach. */
export const REVOCATION_GRACE_WINDOW_MS = 30 * 60 * 1000;

// ─── Poison mutations (S-7) ──────────────────────────────────────────────────

/** Handler-5xx count after which a mutation is terminally rejected instead of re-running forever. */
export const POISON_MUTATION_MAX_FAILURES = 7;

// ─── Read-side safety lag ────────────────────────────────────────────────────

/**
 * Filters only serve rows with modified_at older than this. The trigger stamps
 * now() = tx-START time, so a long write tx can commit a row with a timestamp
 * a concurrent poll's watermark already passed — the no-gap advance (§7) covers
 * the read window, this lag covers in-flight transactions.
 */
export const READ_SAFETY_LAG_MS = 2_000;

// ─── Sync entity identity ────────────────────────────────────────────────────

/**
 * The canonical set of syncable entity types — the single source of truth for
 * every entity identity across the filter registry, the cursor payload, and the
 * mutation router. A registry entry or cursor key that doesn't match one of
 * these is a compile error rather than a silent runtime miss.
 *
 * NOTE: the wire strings are intentionally NOT all snake_case — `taxrate` and
 * `paymentaccount` are concatenated for historical/client-contract reasons.
 * Do not "normalize" them here without a coordinated client migration.
 */
export const SYNC_ENTITY_TYPES = [
  'store',
  'unit',
  'store_device_access',
  'lookup',
  'payment_method',
  'taxrate',
  'product',
  'product_case',
  'paymentaccount',
  'customer',
  'supplier',
  'staff',
] as const;

export type SyncEntityType = (typeof SYNC_ENTITY_TYPES)[number];

/** Narrow an arbitrary (client-supplied) string to a known sync entity type. */
export function isSyncEntityType(value: string): value is SyncEntityType {
  return (SYNC_ENTITY_TYPES as readonly string[]).includes(value);
}

// ─── Cursor codec (§4) ───────────────────────────────────────────────────────

export const SYNC_CURSOR_VERSION = 4;

/** Domain-separation label for the cursor HMAC key: HMAC(rootSecret, label). */
export const CURSOR_HMAC_DOMAIN = 'sync-cursor-hmac-v1';