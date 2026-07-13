/**
 * Every sync-engine tunable in one place (sync-engine.md §22 S-10). Encode
 * RELATIONSHIPS, not magic numbers — the tombstone-retention/horizon inversion
 * (S-22: retention < horizon → silently resurrected rows) happened because the
 * two constants lived in different files with no encoded dependency.
 */
import { MS_PER_DAY } from '#common/time.js';

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

export const SYNC_HORIZON_MS = SYNC_HORIZON_DAYS * MS_PER_DAY;

// ─── Page sizes (§2) ─────────────────────────────────────────────────────────

/** Steady-state delta page — shared fairly across entities. */
export const DELTA_PAGE_SIZE = 200;

/** Per-entity floor so one entity's backlog never starves to ~10 rows/poll (S-11). */
export const PER_ENTITY_FLOOR = 20;

/** Cold-start bulk-dump page — the page size, not parallelism, is the cold-start lever (S-27). */
export const INITIAL_PAGE_SIZE = 1000;

// ─── Rate limits (§16) ───────────────────────────────────────────────────────
// Keyed per (user, store, device) — NOT just (user, store): real small-retail
// usage is one owner login on 2-3 counter devices, and a store-only key would
// have those devices throttle each other exactly at rush hour.

/** /sync/changes — a pure read, generous budget. */
export const SYNC_CHANGES_RATE_LIMIT = { windowSeconds: 60, limit: 60 };

/** /sync/delta — push+pull combined, tighter than a pure read. */
export const SYNC_DELTA_RATE_LIMIT = { windowSeconds: 60, limit: 20 };

/** /sync/delta mutation volume — separate from the request-rate limit above so
 *  a client can't dodge it by cramming more mutations into fewer calls. */
export const SYNC_MUTATION_RATE_LIMIT = { windowSeconds: 300, limit: 100 };

// ─── Push limits (§9) ────────────────────────────────────────────────────────

export const MAX_MUTATIONS_PER_BATCH = 100;

/**
 * Cap on independent mutations processed concurrently within one "wave"
 * (computeWaves in push/delta.service.ts). Each mutation opens its own
 * transaction against the shared, app-wide DB pool (DB_POOL_MAX defaults to
 * 10, config/env.ts) — an unbounded `Promise.all` over a wave of up to
 * MAX_MUTATIONS_PER_BATCH mutations could claim the entire pool from one
 * device's single /sync/delta call. Stays well under the pool size so one
 * batch can never starve the rest of the app.
 */
export const WAVE_CONCURRENCY = 4;

/** Per-mutation payload cap (S-36) — a 500-line B2B order must be split client-side. */
export const MAX_MUTATION_PAYLOAD_BYTES = 64 * 1024;

// ─── Idempotency TTLs (§10) ──────────────────────────────────────────────────

/**
 * Applied/rejected idempotency rows must OUTLIVE the longest interval after
 * which a client can still legitimately replay a mutation_id (S-35, C2). If the
 * row is purged first, the replay is no longer recognised as a duplicate and
 * the business write RE-EXECUTES → double sale. The TTL is therefore DERIVED
 * from the two client replay bounds, never set as a bare magic number:
 *   - CLIENT_DLQ_MAX_DWELL_DAYS: how long a mutation may sit dead/quarantined
 *     on the client before a manual retry (the mobile client mirrors this and
 *     REFUSES to replay a mutation_id older than IDEMPOTENCY_TTL_DAYS, closing
 *     the window from the other side — belt and suspenders).
 *   - REFRESH_TOKEN_LIFE_DAYS: a client with an expired refresh token can't
 *     authenticate to replay at all (REFRESH_TOKEN_TTL_SECONDS = 30 d, env.ts).
 * Drift-proof: bump a bound and the TTL moves with it.
 */
export const CLIENT_DLQ_MAX_DWELL_DAYS = 30;
export const REFRESH_TOKEN_LIFE_DAYS = 30;
export const IDEMPOTENCY_TTL_MARGIN_DAYS = 15;
export const IDEMPOTENCY_TTL_DAYS =
  Math.max(CLIENT_DLQ_MAX_DWELL_DAYS, REFRESH_TOKEN_LIFE_DAYS) + IDEMPOTENCY_TTL_MARGIN_DAYS; // 45
export const IDEMPOTENCY_TTL_MS = IDEMPOTENCY_TTL_DAYS * MS_PER_DAY;

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
  'cash_movement',
  'account_transaction',
  'sale',
  'sale_line',
  'sale_payment',
  'refund',
  'refund_line',
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