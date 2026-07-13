import { and, asc, eq, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { DbExecutor } from '#db/db.module.js';
import type { EntityCode } from '#common/rbac/permission-matrix.constants.js';
import type { EffectivePermissions } from '#common/rbac/effective-permissions.js';
import { type SyncEntityType } from '../sync.constants.js';
import { assertMicroIso, microIso } from '../us-timestamp.js';
import { readLagPredicate } from '../pull/read-cutoff.js';
import type { EntityWatermark } from '../cursor/sync-cursor.service.js';

/** Floor id for a fresh keyset — every real uuid sorts after it. */
export const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

export interface SyncPullContext {
  db: DbExecutor;
  storeId: string;
  userId: string;
  permissions: EffectivePermissions;
}

/** A wire row: snake_case, `modified_at` as the µs watermark string. */
export type WireRow = Record<string, unknown>;

export interface DeltaPage {
  rows: WireRow[];
  /** Keyset position of the last row returned — the no-gap advance target (§7). */
  watermark: EntityWatermark | null;
  hasMore: boolean;
}

export interface InitialPage {
  rows: WireRow[];
  lastId: string | null;
  hasMore: boolean;
}

/**
 * One synced entity's pull implementation (sync-engine.md §3). The registry
 * iterates these in `dependencyOrder` for cold start; `/sync/changes` fans out
 * across them with a fair per-entity budget.
 */
export interface SyncEntityFilter {
  entityType: SyncEntityType;
  dependencyOrder: number;
  /** RBAC gate — a user without `view` on this gets an empty page (§18). */
  permissionEntity: EntityCode;
  pullChanges(
    ctx: SyncPullContext,
    after: EntityWatermark,
    limit: number,
    /** Read-safety cutoff (B2) — see `computeReadCutoff`; `null` → inline fixed lag. */
    cutoff: string | null,
  ): Promise<DeltaPage>;
  pullInitial(ctx: SyncPullContext, afterId: string | null, limit: number): Promise<InitialPage>;
  estimateCount(ctx: SyncPullContext): Promise<number>;
}

/** camelCase → snake_case key conversion for wire rows — shared with
 *  push/master-data.handler.ts's `wireRow`, which needs the identical rule
 *  for the conflict/applied-data serialization it does on the push side. */
export const camelToSnake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/**
 * Serialize a DB row to the wire: snake_case keys, ISO timestamps, and
 * `modified_at` replaced by the SQL-rendered µs string (never the JS Date —
 * BR-SYNC-004). `assertMicroIso` is the S-8 runtime enforcement point.
 */
function toWireRow(row: Record<string, unknown>, entityType: SyncEntityType): WireRow {
  const out: WireRow = {};
  const micro = row['__modifiedAtUs'];
  for (const [key, value] of Object.entries(row)) {
    if (key === '__modifiedAtUs') continue;
    if (key === 'modifiedAt') {
      out['modified_at'] = assertMicroIso(String(micro), entityType);
      continue;
    }
    out[camelToSnake(key)] = value instanceof Date ? value.toISOString() : value;
  }
  return out;
}

interface GenericFilterConfig {
  entityType: SyncEntityType;
  dependencyOrder: number;
  permissionEntity: EntityCode;
  table: PgTable;
  idColumn: AnyPgColumn;
  modifiedAtColumn: AnyPgColumn;
  /** Tenant scope for this entity (store-scoped, global-or-store, single row…). */
  scopeWhere: (ctx: SyncPullContext) => SQL | undefined;
  /** Exclude soft-deleted rows — deletes travel as tombstones, not upserts. */
  aliveWhere?: SQL;
  /**
   * REQUIRED explicit wire projection (keys stay camelCase). Security by
   * omission (§3.7): a new sensitive column is invisible to synced clients until
   * it's deliberately added here — never a `SELECT *` that ships every column.
   */
  columns: Record<string, AnyPgColumn>;
}

/**
 * Keyset filter over one store-partitioned table.
 *
 * Delta predicate (§4): `modified_at > ts OR (modified_at = ts AND id > id)`,
 * ordered `(modified_at, id) ASC` — no skips on identical timestamps, no
 * infinite loop. Rows younger than READ_SAFETY_LAG_MS are withheld: the trigger
 * stamps tx-START time, so an in-flight transaction can commit "into the past"
 * of an already-advanced watermark; the lag keeps those reachable.
 */
export class GenericSyncFilter implements SyncEntityFilter {
  readonly entityType: SyncEntityType;
  readonly dependencyOrder: number;
  readonly permissionEntity: EntityCode;

  constructor(private readonly cfg: GenericFilterConfig) {
    this.entityType = cfg.entityType;
    this.dependencyOrder = cfg.dependencyOrder;
    this.permissionEntity = cfg.permissionEntity;
  }

  private selection() {
    return { ...this.cfg.columns, __modifiedAtUs: microIso(this.cfg.modifiedAtColumn) };
  }

  async pullChanges(
    ctx: SyncPullContext,
    after: EntityWatermark,
    limit: number,
    cutoff: string | null,
  ): Promise<DeltaPage> {
    const { modifiedAtColumn: mod, idColumn: id } = this.cfg;
    const keyset = sql`(${mod} > ${after.ts}::timestamptz OR (${mod} = ${after.ts}::timestamptz AND ${id} > ${after.id || ZERO_UUID}::uuid))`;
    const lag = readLagPredicate(mod, cutoff);

    const rows = await ctx.db
      .select(this.selection())
      .from(this.cfg.table)
      .where(and(this.cfg.scopeWhere(ctx), this.cfg.aliveWhere, keyset, lag))
      .orderBy(asc(mod), asc(id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page.at(-1) as Record<string, unknown> | undefined;

    return {
      rows: page.map((r) => toWireRow(r as Record<string, unknown>, this.entityType)),
      // No-gap advance (§7, BR-SYNC-005): only to the last row actually
      // returned — never to a pre-query serverNow. Empty page → caller keeps
      // the previous watermark.
      watermark: last
        ? { ts: assertMicroIso(String(last['__modifiedAtUs']), this.entityType), id: String(last[this.idKey()]) }
        : null,
      hasMore,
    };
  }

  async pullInitial(ctx: SyncPullContext, afterId: string | null, limit: number): Promise<InitialPage> {
    const { idColumn: id } = this.cfg;

    const rows = await ctx.db
      .select(this.selection())
      .from(this.cfg.table)
      .where(and(
        this.cfg.scopeWhere(ctx),
        this.cfg.aliveWhere,
        afterId ? sql`${id} > ${afterId}::uuid` : undefined,
      ))
      .orderBy(asc(id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page.at(-1) as Record<string, unknown> | undefined;

    return {
      rows: page.map((r) => toWireRow(r as Record<string, unknown>, this.entityType)),
      lastId: last ? String(last[this.idKey()]) : null,
      hasMore,
    };
  }

  async estimateCount(ctx: SyncPullContext): Promise<number> {
    const [row] = await ctx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(this.cfg.table)
      .where(and(this.cfg.scopeWhere(ctx), this.cfg.aliveWhere));
    return row?.n ?? 0;
  }

  /** The camelCase key `idColumn` lands under in the selection. */
  private idKey(): string {
    for (const [key, col] of Object.entries(this.cfg.columns)) {
      if (col === this.cfg.idColumn) return key;
    }
    return 'id';
  }
}

/** Store-scoped table: `store_fk = :store`. */
export const storeScope = (storeFk: AnyPgColumn) =>
  (ctx: SyncPullContext): SQL | undefined => eq(storeFk, ctx.storeId);

/** Global-or-store reference data (lookup): `store_fk IS NULL OR store_fk = :store`. */
export const globalOrStoreScope = (storeFk: AnyPgColumn) =>
  (ctx: SyncPullContext): SQL | undefined => or(isNull(storeFk), eq(storeFk, ctx.storeId));

/** The store row itself: `id = :store`. */
export const selfStoreScope = (idColumn: AnyPgColumn) =>
  (ctx: SyncPullContext): SQL | undefined => eq(idColumn, ctx.storeId);