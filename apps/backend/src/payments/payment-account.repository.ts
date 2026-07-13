import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DRIZZLE, type DbExecutor } from '#db/db.module.js';
import * as schema from '#db/schema.js';
import { paymentAccounts } from '#db/schema.js';
import type { PaymentAccountRow } from './types/payment-account.types.js';

const cols = {
  guuid: paymentAccounts.guuid,
  name: paymentAccounts.name,
  kind: paymentAccounts.kind,
  details: paymentAccounts.details,
  isDefault: paymentAccounts.isDefault,
  isActive: paymentAccounts.isActive,
  isSystem: paymentAccounts.isSystem,
  systemKey: paymentAccounts.systemKey,
  rowVersion: paymentAccounts.rowVersion,
};

@Injectable()
export class PaymentAccountRepository {
  constructor(@Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>) {}

  private client(tx?: DbExecutor) {
    return tx ?? this.db;
  }

  /**
   * Alive accounts for a store in a stable, explicit order (#12): the default
   * first, then active before inactive, then system (Cash/Bank) before custom,
   * then by name.
   */
  async listAlive(storeId: string, tx?: DbExecutor): Promise<PaymentAccountRow[]> {
    return this.client(tx)
      .select(cols)
      .from(paymentAccounts)
      .where(and(eq(paymentAccounts.storeFk, storeId), isNull(paymentAccounts.deletedAt)))
      .orderBy(
        desc(paymentAccounts.isDefault),
        desc(paymentAccounts.isActive),
        desc(paymentAccounts.isSystem),
        asc(paymentAccounts.name),
      ) as Promise<PaymentAccountRow[]>;
  }

  /**
   * BR-9: resolve the store's default tender. Resolution order:
   *   1. the account flagged `is_default`, else
   *   2. the Cash system row (`system_key = 'cash'`), else
   *   3. the first active account by name.
   * Only active, non-deleted rows are considered. This is **total** for any
   * seeded store — Cash is `is_system`, so the seed-lock forbids ever deleting
   * or deactivating it, guaranteeing it always backstops step 2. A consumer can
   * therefore treat a non-null result as invariant for a real store. Returns
   * null only for a store with no accounts at all (never happens post-seeding).
   */
  async getDefaultAccount(storeId: string, tx?: DbExecutor): Promise<PaymentAccountRow | null> {
    const [row] = await this.client(tx)
      .select(cols)
      .from(paymentAccounts)
      .where(
        and(
          eq(paymentAccounts.storeFk, storeId),
          isNull(paymentAccounts.deletedAt),
          eq(paymentAccounts.isActive, true),
        ),
      )
      .orderBy(
        desc(paymentAccounts.isDefault),
        desc(sql`${paymentAccounts.systemKey} = 'cash'`),
        asc(paymentAccounts.name),
      )
      .limit(1);
    return (row as PaymentAccountRow) ?? null;
  }

  /** One alive account by guuid (for returning the row after a write). */
  async findOne(storeId: string, guuid: string, tx?: DbExecutor): Promise<PaymentAccountRow | null> {
    const [row] = await this.client(tx)
      .select(cols)
      .from(paymentAccounts)
      .where(
        and(
          eq(paymentAccounts.storeFk, storeId),
          eq(paymentAccounts.guuid, guuid),
          isNull(paymentAccounts.deletedAt),
        ),
      )
      .limit(1);
    return (row as PaymentAccountRow) ?? null;
  }
}
