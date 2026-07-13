import { and, eq, getTableColumns, isNull, or, type SQL } from 'drizzle-orm';
import type { PgTable, AnyPgColumn } from 'drizzle-orm/pg-core';
import type { ZodType } from 'zod';
import { ErrorCodes } from '#common/error-codes.js';
import type { EntityCode } from '#common/rbac/permission-matrix.constants.js';
import { camelToSnake, type WireRow } from '../registry/entity-filter.js';
import type { SyncEntityType } from '../sync.constants.js';
import type {
  HandlerOutcome,
  MutationAction,
  MutationContext,
  SyncMutationHandler,
} from './mutation.types.js';

function wireRow(row: Record<string, unknown>): WireRow {
  const out: WireRow = {};
  for (const [key, value] of Object.entries(row)) {
    out[camelToSnake(key)] = value instanceof Date ? value.toISOString() : value;
  }
  return out;
}

/**
 * Resolve a payload reference (usually a guuid) to the target row's id.
 * Deliberately duplicated from master-data.handler.ts rather than shared: the
 * two handler bases have different write semantics (optimistic-lock update
 * vs create-only) and that file is explicitly marked "DO NOT reuse ... for
 * shift/cash" — keep this one self-contained so a change to master-data
 * resolution never silently reaches append-only writes, or vice versa.
 */
export interface FkResolver {
  field: string;
  column: string;
  table: PgTable;
  matchOn: AnyPgColumn;
  idColumn: AnyPgColumn;
  scope: 'store' | 'globalOrStore' | 'global';
  storeFkColumn?: AnyPgColumn;
}

async function resolveFks(
  resolvers: FkResolver[],
  data: Record<string, unknown>,
  ctx: MutationContext,
): Promise<HandlerOutcome | { columns: Record<string, unknown> }> {
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
      return {
        kind: 'rejected',
        code: ErrorCodes.VALIDATION_FAILED,
        message: `unknown ${result.resolver.field}: ${String(result.value)}`,
        conflictType: 'VALIDATION',
      };
    }
    columns[result.resolver.column] = result.id;
  }
  return { columns };
}

export interface AppendOnlyHandlerConfig {
  entityType: SyncEntityType;
  permissionEntity: EntityCode;
  table: PgTable;
  idColumn: AnyPgColumn;
  guuidColumn: AnyPgColumn;
  storeFkColumn: AnyPgColumn;
  createSchema: ZodType<Record<string, unknown>>;
  /** Validated snake_case payload → camelCase column values. Create only —
   *  there is no update/delete path (corrections are new events, D-SD4). */
  mapColumns: (data: Record<string, unknown>, ctx: MutationContext) => Record<string, unknown>;
  fkResolvers?: FkResolver[];
  /**
   * Runs in the SAME transaction immediately after insert, e.g. the posting
   * service deriving `account_transactions` rows from the just-inserted
   * event. Returning a HandlerOutcome overrides the default `applied` result
   * — the whole business transaction (not just this insert) rolls back, so a
   * rejection here leaves no partial event, exactly like a pre-insert reject.
   */
  onInserted?: (row: Record<string, unknown>, ctx: MutationContext) => Promise<HandlerOutcome | null>;
}

/**
 * The insert-only write primitive for event-sourced/transactional data
 * (docs/prd/accounts-and-ledger.md D1, sync-engine.md master-data.handler.ts
 * ~L78 "DO NOT reuse [MasterDataSyncHandler] for orders/stock/shift/cash").
 * No update, no delete, no row_version gate: two concurrent cash movements
 * are both valid and simply accumulate. Idempotency comes from the pipeline
 * (mutation_id dedupe in delta.service.ts) plus the entity's own `guuid`
 * unique constraint — a genuine resubmit under a fresh mutation_id hits the
 * same 23505-mapping path master-data creates already rely on
 * (mapConstraintViolation in delta.service.ts).
 */
export abstract class AppendOnlySyncHandler implements SyncMutationHandler {
  readonly entityType: SyncEntityType;
  readonly permissionEntity: EntityCode;

  private readonly keyBySqlName: Map<string, string>;

  constructor(private readonly cfg: AppendOnlyHandlerConfig) {
    this.entityType = cfg.entityType;
    this.permissionEntity = cfg.permissionEntity;
    this.keyBySqlName = new Map(
      Object.entries(getTableColumns(cfg.table)).map(([tsKey, col]) => [col.name, tsKey]),
    );
  }

  async apply(
    action: MutationAction,
    payload: Record<string, unknown>,
    _expectedRowVersion: number | undefined,
    ctx: MutationContext,
  ): Promise<HandlerOutcome> {
    if (action !== 'create') {
      return {
        kind: 'rejected',
        code: ErrorCodes.VALIDATION_FAILED,
        message: `${this.entityType} is append-only — ${action} is not supported; corrections are new events`,
        conflictType: 'VALIDATION',
      };
    }
    return this.create(payload, ctx);
  }

  private async create(payload: Record<string, unknown>, ctx: MutationContext): Promise<HandlerOutcome> {
    const parsed = this.cfg.createSchema.safeParse(payload);
    if (!parsed.success) return this.validationFailure(parsed.error.issues);

    const data = parsed.data;
    const fks = await resolveFks(this.cfg.fkResolvers ?? [], data, ctx);
    if ('kind' in fks) return fks;

    const values = {
      storeFk: ctx.storeId,
      guuid: data.guuid as string,
      deviceFk: ctx.deviceId,
      createdBy: ctx.userId,
      ...this.cfg.mapColumns(data, ctx),
      ...fks.columns,
    };

    // `as never`: see master-data.handler.ts's identical cast — values is
    // assembled dynamically for a config-driven table; the Zod create schema
    // validates every payload field and columnKey() below throws for any
    // structural mismatch, so column correctness is enforced at runtime.
    const [row] = await ctx.tx
      .insert(this.cfg.table)
      .values(values as never)
      .returning();

    const inserted = row as Record<string, unknown>;

    if (this.cfg.onInserted) {
      const overridden = await this.cfg.onInserted(inserted, ctx);
      if (overridden) return overridden;
    }

    return {
      kind: 'applied',
      entityId: String(inserted[this.columnKey(this.cfg.idColumn)]),
      entityGuuid: String(inserted[this.columnKey(this.cfg.guuidColumn)]),
      data: wireRow(inserted),
    };
  }

  private validationFailure(issues: { path: PropertyKey[]; message: string }[]): HandlerOutcome {
    const detail = issues
      .slice(0, 5)
      .map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message))
      .join('; ');
    return {
      kind: 'rejected',
      code: ErrorCodes.VALIDATION_FAILED,
      message: detail || 'invalid payload',
      conflictType: 'VALIDATION',
    };
  }

  private columnKey(column: AnyPgColumn): string {
    const key = this.keyBySqlName.get(column.name);
    if (key === undefined) {
      throw new Error(
        `[sync] column '${column.name}' is not part of '${this.entityType}' table metadata — check the handler config`,
      );
    }
    return key;
  }
}