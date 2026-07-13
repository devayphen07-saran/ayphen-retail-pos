import { and, eq, getTableColumns, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { PgTable, AnyPgColumn } from 'drizzle-orm/pg-core';
import type { ZodType } from 'zod';
import { ErrorCodes } from '#common/error-codes.js';
import type { EntityCode } from '#common/rbac/permission-matrix.constants.js';
import type { DbTransaction } from '#db/db.module.js';
import { TombstoneRepository } from '../repositories/tombstone.repository.js';
import { camelToSnake, type WireRow } from '../registry/entity-filter.js';
import type { SyncEntityType } from '../sync.constants.js';
import type {
  HandlerOutcome,
  MutationAction,
  MutationContext,
  SyncMutationHandler,
} from './mutation.types.js';

/** Serialize a row for conflict `server_row` / applied `data`. NOT the pull
 *  path — the authoritative µs `modified_at` watermark only travels via
 *  filters; here plain ISO is fine (the client re-pulls the row anyway). */
function wireRow(row: Record<string, unknown>): WireRow {
  const out: WireRow = {};
  for (const [key, value] of Object.entries(row)) {
    out[camelToSnake(key)] = value instanceof Date ? value.toISOString() : value;
  }
  return out;
}

/** Resolve a payload reference (usually a guuid) to the target row's id. */
export interface FkResolver {
  /** snake_case payload field, e.g. 'unit_guuid' or 'lookup_type_code'. */
  field: string;
  /** camelCase column key the resolved id lands in, e.g. 'unitFk'. */
  column: string;
  table: PgTable;
  /** Column the payload value matches on (guuid for synced tables, code for lookup_type). */
  matchOn: AnyPgColumn;
  idColumn: AnyPgColumn;
  /** Tenant scope of the referenced table. */
  scope: 'store' | 'globalOrStore' | 'global';
  storeFkColumn?: AnyPgColumn;
}

export interface MasterDataHandlerConfig {
  entityType: SyncEntityType;
  permissionEntity: EntityCode;
  table: PgTable;
  idColumn: AnyPgColumn;
  guuidColumn: AnyPgColumn;
  rowVersionColumn: AnyPgColumn;
  storeFkColumn: AnyPgColumn;
  createSchema: ZodType<Record<string, unknown>>;
  updateSchema: ZodType<Record<string, unknown>>;
  /**
   * Validated snake_case payload → camelCase column values, audit columns
   * included. Return only the fields present (updates are partial); FK fields
   * are handled by `fkResolvers`, not here.
   */
  mapColumns: (
    data: Record<string, unknown>,
    ctx: MutationContext,
    action: 'create' | 'update',
  ) => Record<string, unknown>;
  fkResolvers?: FkResolver[];
  /** How this table soft-deletes: audit deletedAt, or an isActive flag (lookup). */
  deleteMode:
    | { kind: 'deletedAt'; column: AnyPgColumn; byColumn?: AnyPgColumn }
    | { kind: 'isActive'; column: AnyPgColumn };
  /** Business-rule veto on the live row before update/delete (e.g. isSystem lookups). */
  guardRow?: (row: Record<string, unknown>) => HandlerOutcome | null;
}

const rejected = (
  code: (typeof ErrorCodes)[keyof typeof ErrorCodes],
  message: string,
  conflictType: 'VALIDATION' | 'BUSINESS_RULE' = 'VALIDATION',
): HandlerOutcome => ({ kind: 'rejected', code, message, conflictType });

/**
 * The optimistic-lock write primitive for master/reference data
 * (sync-engine.md §11/§13). Read + version-gated update happen in ONE
 * statement (no TOCTOU); zero rows updated → `conflict` with the live row.
 *
 * DO NOT reuse this for orders/stock/shift/cash: transactional data is
 * additive/event-sourced (BR-SYNC-010) — a concurrent sale is not a
 * row_version conflict.
 */
export abstract class MasterDataSyncHandler implements SyncMutationHandler {
  readonly entityType: SyncEntityType;
  readonly permissionEntity: EntityCode;

  /** SQL column name → the TS property key it lands under in a full-row
   *  select/insert. Built from the real Drizzle metadata (F5) — the previous
   *  snake→camel regex silently mapped to the wrong key for any column whose TS
   *  key isn't the exact camelCase of its SQL name (an explicit alias). */
  private readonly keyBySqlName: Map<string, string>;

  constructor(
    private readonly cfg: MasterDataHandlerConfig,
    private readonly tombstones: TombstoneRepository,
  ) {
    this.entityType = cfg.entityType;
    this.permissionEntity = cfg.permissionEntity;
    this.keyBySqlName = new Map(
      Object.entries(getTableColumns(cfg.table)).map(([tsKey, col]) => [col.name, tsKey]),
    );
  }

  async apply(
    action: MutationAction,
    payload: Record<string, unknown>,
    expectedRowVersion: number | undefined,
    ctx: MutationContext,
  ): Promise<HandlerOutcome> {
    switch (action) {
      case 'create':
        return this.create(payload, ctx);
      case 'update':
        // Preflight (delta.service.ts step 6) is expected to reject an update
        // with no row_version before this handler ever runs — but that
        // invariant lives in a different file with nothing enforcing it here.
        // Reject explicitly rather than coercing undefined → number, which
        // would silently turn the optimistic-lock WHERE clause into an
        // always-false predicate (every update reads as a conflict).
        if (expectedRowVersion === undefined) {
          return rejected(
            ErrorCodes.SYNC_MISSING_ROW_VERSION,
            `update of ${this.entityType} requires expected_row_version`,
          );
        }
        return this.update(payload, expectedRowVersion, ctx);
      case 'delete':
        return this.remove(payload, ctx);
    }
  }

  // ── create ─────────────────────────────────────────────────────────────────

  private async create(payload: Record<string, unknown>, ctx: MutationContext): Promise<HandlerOutcome> {
    const parsed = this.cfg.createSchema.safeParse(payload);
    if (!parsed.success) return this.validationFailure(parsed.error.issues);

    const data = parsed.data;
    const fks = await this.resolveFks(data, ctx);
    if ('kind' in fks) return fks;

    const values = {
      storeFk: ctx.storeId,
      guuid: data.guuid as string,
      ...this.cfg.mapColumns(data, ctx, 'create'),
      ...fks.columns,
    };

    // Unique violations (guuid replay under a new mutation_id, SKU races) bubble
    // as PostgresError 23505 — the pipeline's savepoint maps them to a rejected
    // DUPLICATE_ENTRY without poisoning the outer transaction.
    //
    // `as never`: `values` is assembled dynamically for a config-driven table
    // (mapColumns + resolved FK columns + computed keys), so it can't be checked
    // against a single static insert model here. Column correctness is enforced
    // at runtime instead — columnKey() throws for any structural column absent
    // from the table metadata, and the Zod create/update schemas validate every
    // payload field before it reaches mapColumns.
    const [row] = await ctx.tx
      .insert(this.cfg.table)
      .values(values as never)
      .returning();

    return this.applied(row as Record<string, unknown>);
  }

  // ── update (optimistic lock, §11) ──────────────────────────────────────────

  private async update(
    payload: Record<string, unknown>,
    expectedRowVersion: number,
    ctx: MutationContext,
  ): Promise<HandlerOutcome> {
    const parsed = this.cfg.updateSchema.safeParse(payload);
    if (!parsed.success) return this.validationFailure(parsed.error.issues);

    const data = parsed.data;
    const guuid = data.guuid as string;

    const guarded = await this.guard(guuid, ctx);
    if (guarded) return guarded;

    const fks = await this.resolveFks(data, ctx);
    if ('kind' in fks) return fks;

    const patch = {
      ...this.cfg.mapColumns(data, ctx, 'update'),
      ...fks.columns,
      // Explicit bump — the sync_touch_row trigger sees it changed and leaves
      // it alone (no double increment).
      [this.columnKey(this.cfg.rowVersionColumn)]: expectedRowVersion + 1,
    };

    const [row] = await ctx.tx
      .update(this.cfg.table)
      .set(patch as never)
      .where(and(
        eq(this.cfg.guuidColumn, guuid),
        eq(this.cfg.storeFkColumn, ctx.storeId),
        this.aliveWhere(),
        eq(this.cfg.rowVersionColumn, expectedRowVersion),
      ))
      .returning();

    if (row) return this.applied(row as Record<string, unknown>);

    // Zero rows — stale version, missing, or deleted. Fetch the live row to tell.
    const current = await this.findByGuuid(ctx.tx, guuid, ctx.storeId);
    if (!current) {
      return rejected(ErrorCodes.NOT_FOUND, `${this.entityType} ${guuid} does not exist in this store`, 'BUSINESS_RULE');
    }
    if (!this.isAlive(current)) {
      return rejected(ErrorCodes.NOT_FOUND, `${this.entityType} ${guuid} was deleted on the server`, 'BUSINESS_RULE');
    }
    return {
      kind: 'conflict',
      entityGuuid: guuid,
      serverRow: wireRow(current),
      message: `stale row_version: expected ${expectedRowVersion}, server has ${String(current[this.columnKey(this.cfg.rowVersionColumn)])}`,
    };
  }

  // ── delete (soft + same-tx tombstone, §8) ──────────────────────────────────

  private async remove(payload: Record<string, unknown>, ctx: MutationContext): Promise<HandlerOutcome> {
    const guuid = typeof payload.guuid === 'string' ? payload.guuid : null;
    if (!guuid) return rejected(ErrorCodes.VALIDATION_FAILED, 'delete payload requires guuid');

    const guarded = await this.guard(guuid, ctx);
    if (guarded) return guarded;

    const del = this.cfg.deleteMode;
    const patch: Record<string, unknown> =
      del.kind === 'deletedAt'
        ? {
            [this.columnKey(del.column)]: sql`now()`,
            ...(del.byColumn ? { [this.columnKey(del.byColumn)]: ctx.userId } : {}),
          }
        : { [this.columnKey(del.column)]: false };

    const [row] = await ctx.tx
      .update(this.cfg.table)
      .set(patch as never)
      .where(and(
        eq(this.cfg.guuidColumn, guuid),
        eq(this.cfg.storeFkColumn, ctx.storeId),
        this.aliveWhere(),
      ))
      .returning();

    if (!row) {
      const current = await this.findByGuuid(ctx.tx, guuid, ctx.storeId);
      if (!current) {
        return rejected(ErrorCodes.NOT_FOUND, `${this.entityType} ${guuid} does not exist in this store`, 'BUSINESS_RULE');
      }
      // Already deleted — idempotent. Refresh the tombstone so it re-surfaces
      // through the keyset for any device that missed it.
      await this.writeTombstone(ctx.tx, guuid, current, ctx);
      return { kind: 'applied', entityGuuid: guuid };
    }

    await this.writeTombstone(ctx.tx, guuid, row as Record<string, unknown>, ctx);
    return { kind: 'applied', entityGuuid: guuid, entityId: String((row as Record<string, unknown>)[this.columnKey(this.cfg.idColumn)]) };
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private async writeTombstone(
    tx: DbTransaction,
    guuid: string,
    row: Record<string, unknown>,
    ctx: MutationContext,
  ): Promise<void> {
    await this.tombstones.write(tx, {
      storeFk: ctx.storeId,
      entityType: this.entityType,
      entityGuuid: guuid,
      entityId: String(row[this.columnKey(this.cfg.idColumn)] ?? '') || undefined,
      deletedByUserFk: ctx.userId,
      hardDelete: false,
    });
  }

  private async guard(guuid: string, ctx: MutationContext): Promise<HandlerOutcome | null> {
    if (!this.cfg.guardRow) return null;
    const row = await this.findByGuuid(ctx.tx, guuid, ctx.storeId);
    return row ? this.cfg.guardRow(row) : null;
  }

  private async findByGuuid(
    tx: DbTransaction,
    guuid: string,
    storeId: string,
  ): Promise<Record<string, unknown> | null> {
    const [row] = await tx
      .select()
      .from(this.cfg.table)
      .where(and(eq(this.cfg.guuidColumn, guuid), eq(this.cfg.storeFkColumn, storeId)))
      .limit(1);
    return (row as Record<string, unknown>) ?? null;
  }

  private async resolveFks(
    data: Record<string, unknown>,
    ctx: MutationContext,
  ): Promise<HandlerOutcome | { columns: Record<string, unknown> }> {
    const resolvers = this.cfg.fkResolvers ?? [];

    // Independent lookups (different field, different table) — resolve them
    // concurrently instead of one at a time; Promise.all preserves resolver
    // order so the first-missing-field error is still deterministic.
    const results = await Promise.all(resolvers.map(async (resolver) => {
      const value = data[resolver.field];
      if (value === undefined) return { resolver, outcome: 'skip' as const };
      if (value === null) return { resolver, outcome: 'null' as const };

      const scope: SQL | undefined =
        resolver.scope === 'store'
          ? eq(resolver.storeFkColumn!, ctx.storeId)
          : resolver.scope === 'globalOrStore'
            ? or(isNull(resolver.storeFkColumn!), eq(resolver.storeFkColumn!, ctx.storeId))
            : undefined;

      const [target] = await ctx.tx
        .select({ id: resolver.idColumn })
        .from(resolver.table)
        .where(and(eq(resolver.matchOn, value as string), scope))
        .limit(1);

      if (!target) return { resolver, outcome: 'missing' as const, value };
      return { resolver, outcome: 'resolved' as const, id: (target as { id: unknown }).id };
    }));

    const columns: Record<string, unknown> = {};
    for (const result of results) {
      if (result.outcome === 'skip') continue;
      if (result.outcome === 'null') {
        columns[result.resolver.column] = null;
        continue;
      }
      if (result.outcome === 'missing') {
        return rejected(ErrorCodes.VALIDATION_FAILED, `unknown ${result.resolver.field}: ${String(result.value)}`);
      }
      columns[result.resolver.column] = result.id;
    }
    return { columns };
  }

  private applied(row: Record<string, unknown>): HandlerOutcome {
    return {
      kind: 'applied',
      entityId: String(row[this.columnKey(this.cfg.idColumn)]),
      entityGuuid: String(row[this.columnKey(this.cfg.guuidColumn)]),
      rowVersion: Number(row[this.columnKey(this.cfg.rowVersionColumn)]),
      data: wireRow(row),
    };
  }

  private validationFailure(issues: { path: PropertyKey[]; message: string }[]): HandlerOutcome {
    const detail = issues
      .slice(0, 5)
      .map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message))
      .join('; ');
    return rejected(ErrorCodes.VALIDATION_FAILED, detail || 'invalid payload');
  }

  private aliveWhere(): SQL | undefined {
    const del = this.cfg.deleteMode;
    return del.kind === 'deletedAt' ? isNull(del.column) : eq(del.column, true);
  }

  private isAlive(row: Record<string, unknown>): boolean {
    const del = this.cfg.deleteMode;
    const key = this.columnKey(del.column);
    return del.kind === 'deletedAt' ? row[key] == null : row[key] === true;
  }

  /** The camelCase key a column lands under in a full-row select/insert —
   *  resolved from the real Drizzle table metadata, never guessed. Throws loudly
   *  if a config column isn't part of this handler's table (a wiring bug). */
  private columnKey(column: AnyPgColumn): string {
    const key = this.keyBySqlName.get(column.name);
    if (key === undefined) {
      throw new Error(
        `[sync] column '${column.name}' is not part of '${this.entityType}' table metadata — check the handler config (F5)`,
      );
    }
    return key;
  }
}