import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { DRIZZLE, type Database, type DbExecutor } from '#db/db.module.js';
import { syncConflicts } from '#db/schema.js';

export type SyncConflictRow = typeof syncConflicts.$inferSelect;
/** Derived from the DB enum column — single source of truth, can't drift. */
export type ConflictType = SyncConflictRow['conflictType'];
export type ConflictStatus = SyncConflictRow['status'];

export interface ConflictInsert {
  mutationId: string;
  userFk: string;
  storeFk: string;
  entityType: string;
  entityGuuid?: string;
  conflictType: ConflictType;
  serverRow?: unknown;
  clientPayload: unknown;
  message?: string;
}

/**
 * Conflict bookkeeping (sync-engine.md §11). The server never merges —
 * resolution flips status; the client rebases and resubmits under the new
 * row_version. `conflict_type` (§11.1) routes client UX.
 */
@Injectable()
export class SyncConflictRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  private client(tx?: DbExecutor) {
    return tx ?? this.db;
  }

  /** Written in the same tx as conflict detection. A retried conflict refreshes the row. */
  async record(entry: ConflictInsert, tx?: DbExecutor): Promise<void> {
    await this.client(tx)
      .insert(syncConflicts)
      .values(entry)
      .onConflictDoUpdate({
        target: [syncConflicts.mutationId, syncConflicts.userFk, syncConflicts.storeFk],
        set: {
          serverRow: entry.serverRow ?? null,
          clientPayload: entry.clientPayload,
          message: entry.message ?? null,
          conflictType: entry.conflictType,
          status: 'open',
          createdAt: sql`now()`,
        },
      });
  }

  async list(
    storeId: string,
    filter: { status?: ConflictStatus; conflictType?: ConflictType },
  ): Promise<SyncConflictRow[]> {
    return this.db
      .select()
      .from(syncConflicts)
      .where(and(
        eq(syncConflicts.storeFk, storeId),
        filter.status ? eq(syncConflicts.status, filter.status) : undefined,
        filter.conflictType ? eq(syncConflicts.conflictType, filter.conflictType) : undefined,
      ))
      .orderBy(desc(syncConflicts.createdAt))
      .limit(200);
  }

  /** Plain read, no mutation — used to authorize before resolve() mutates. */
  async findByMutationId(storeId: string, mutationId: string): Promise<SyncConflictRow | null> {
    const [row] = await this.db
      .select()
      .from(syncConflicts)
      .where(and(
        eq(syncConflicts.storeFk, storeId),
        eq(syncConflicts.mutationId, mutationId),
      ));
    return row ?? null;
  }

  async resolve(
    storeId: string,
    mutationId: string,
    patch: { status: 'resolved' | 'discarded'; note?: string; resolvedBy: string },
  ): Promise<SyncConflictRow | null> {
    const [row] = await this.db
      .update(syncConflicts)
      .set({
        status: patch.status,
        note: patch.note,
        resolvedBy: patch.resolvedBy,
        resolvedAt: sql`now()`,
      })
      .where(and(
        eq(syncConflicts.storeFk, storeId),
        eq(syncConflicts.mutationId, mutationId),
      ))
      .returning();
    return row ?? null;
  }
}