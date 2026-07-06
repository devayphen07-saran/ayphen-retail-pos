import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { DRIZZLE, type Database } from '#db/db.module.js';
import { syncMutationFailures } from '#db/schema.js';

/**
 * Poison-mutation tracking (S-7). A handler 5xx rolls back its business tx, so
 * this is upserted on the ROOT connection afterwards — the failure count must
 * survive the rollback or a permanently-500ing mutation re-runs its handler on
 * every sync forever.
 */
@Injectable()
export class SyncMutationFailureRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async count(mutationId: string, userId: string): Promise<number> {
    const [row] = await this.db
      .select({ n: syncMutationFailures.failureCount })
      .from(syncMutationFailures)
      .where(and(
        eq(syncMutationFailures.mutationId, mutationId),
        eq(syncMutationFailures.userFk, userId),
      ));
    return row?.n ?? 0;
  }

  async bump(mutationId: string, userId: string, message: string): Promise<number> {
    const [row] = await this.db
      .insert(syncMutationFailures)
      .values({
        mutationId,
        userFk: userId,
        failureCount: 1,
        lastErrorMessage: message.slice(0, 500),
      })
      .onConflictDoUpdate({
        target: [syncMutationFailures.mutationId, syncMutationFailures.userFk],
        set: {
          failureCount: sql`${syncMutationFailures.failureCount} + 1`,
          lastErrorMessage: message.slice(0, 500),
          lastFailedAt: sql`now()`,
        },
      })
      .returning({ n: syncMutationFailures.failureCount });
    return row?.n ?? 1;
  }
}