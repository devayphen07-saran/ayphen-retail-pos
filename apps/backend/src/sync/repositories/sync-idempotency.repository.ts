import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE, type Database, type DbExecutor } from '#db/db.module.js';
import { syncMutationIdempotency } from '#db/schema.js';
import {
  IDEMPOTENCY_CONFLICT_TTL_MS,
  IDEMPOTENCY_TTL_MS,
} from '../sync.constants.js';

export type IdempotencyRow = typeof syncMutationIdempotency.$inferSelect;

export interface IdempotencyInsert {
  mutationId: string;
  userFk: string;
  storeFk: string;
  entityType: string;
  action: string;
  status: 'applied' | 'rejected' | 'conflict';
  result: unknown;
}

/**
 * Mutation idempotency (sync-engine.md §10). PK (mutation_id, user_fk) —
 * cross-tenant-safe at the DB. The claim insert runs in the SAME tx as the
 * business write; `ON CONFLICT DO NOTHING` + a returning check is the
 * concurrent-duplicate race detector (loser rolls back and polls the winner).
 */
@Injectable()
export class SyncIdempotencyRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  private client(tx?: DbExecutor) {
    return tx ?? this.db;
  }

  async find(mutationId: string, userId: string, tx?: DbExecutor): Promise<IdempotencyRow | null> {
    const [row] = await this.client(tx)
      .select()
      .from(syncMutationIdempotency)
      .where(and(
        eq(syncMutationIdempotency.mutationId, mutationId),
        eq(syncMutationIdempotency.userFk, userId),
      ));
    return row ?? null;
  }

  /**
   * TTL is enforced at read time (§10/§19 — the cleanup cron is space-only):
   * conflicts expire in 5 min so a post-merge resubmit isn't wrongly returned
   * as a stale duplicate; applied/rejected live 45 d (≥ client DLQ max-dwell,
   * S-35 — an expired row on retry means re-execution, i.e. a double sale).
   */
  isLive(row: IdempotencyRow, now: Date = new Date()): boolean {
    const ttl = row.status === 'conflict' ? IDEMPOTENCY_CONFLICT_TTL_MS : IDEMPOTENCY_TTL_MS;
    return now.getTime() - row.createdAt.getTime() < ttl;
  }

  /**
   * Claim this mutation id inside the business tx. Returns false when another
   * concurrent execution won the insert — the caller must roll back and poll.
   */
  async claim(tx: DbExecutor, entry: IdempotencyInsert): Promise<boolean> {
    const inserted = await tx
      .insert(syncMutationIdempotency)
      .values(entry)
      .onConflictDoNothing()
      .returning({ mutationId: syncMutationIdempotency.mutationId });
    return inserted.length > 0;
  }

  /**
   * Record a terminal outcome OUTSIDE a business tx (business-rule rejections,
   * poison-cap rejections — there is no surviving tx to share). Best-effort on
   * conflict: an existing row (the race winner) wins.
   */
  async record(entry: IdempotencyInsert, tx?: DbExecutor): Promise<void> {
    await this.client(tx)
      .insert(syncMutationIdempotency)
      .values(entry)
      .onConflictDoNothing();
  }

  /** Drop an expired row so a legitimate re-execution can claim the key again. */
  async remove(mutationId: string, userId: string, tx?: DbExecutor): Promise<void> {
    await this.client(tx)
      .delete(syncMutationIdempotency)
      .where(and(
        eq(syncMutationIdempotency.mutationId, mutationId),
        eq(syncMutationIdempotency.userFk, userId),
      ));
  }
}