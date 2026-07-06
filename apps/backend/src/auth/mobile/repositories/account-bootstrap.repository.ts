import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DRIZZLE, type DbExecutor } from '#db/db.module.js';
import { requireRow } from '#db/require-row.js';
import * as schema from '#db/schema.js';
import { accounts, accountUsers, accountSubscriptions, plans } from '#db/schema.js';

/**
 * Data access for provisioning a brand-new tenant (account + membership +
 * subscription) during signup. Every method takes the caller's transaction so
 * the whole bootstrap commits or rolls back with user creation.
 */
@Injectable()
export class AccountBootstrapRepository {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>,
  ) {}

  async findPlanIdByName(name: string, tx?: DbExecutor): Promise<string | null> {
    const [row] = await (tx ?? this.db).select({ id: plans.id }).from(plans).where(eq(plans.name, name));
    return row?.id ?? null;
  }

  async insertAccount(
    data: { accountNumber: string; name: string; ownerUserFk: string },
    tx?: DbExecutor,
  ): Promise<{ id: string; accountNumber: string }> {
    const [row] = await (tx ?? this.db)
      .insert(accounts)
      .values(data)
      .returning({ id: accounts.id, accountNumber: accounts.accountNumber });
    return requireRow(row);
  }

  async insertMembership(
    data: { accountFk: string; userFk: string },
    tx?: DbExecutor,
  ): Promise<void> {
    await (tx ?? this.db).insert(accountUsers).values(data);
  }

  /**
   * Create the subscription in 'trialing' with no window yet — the trial clock
   * starts at first store-create, not signup (subscription.md §1). The DB CHECK
   * allows a null access_valid_until only while status = 'trialing'.
   */
  async insertTrialingSubscription(
    data: { accountFk: string; planFk: string },
    tx?: DbExecutor,
  ): Promise<{ id: string }> {
    const [row] = await (tx ?? this.db)
      .insert(accountSubscriptions)
      .values({
        accountFk:        data.accountFk,
        planFk:           data.planFk,
        status:           'trialing',
        trialEndsAt:      null,
        accessValidUntil: null,
        hasUsedTrial:     false,
      })
      .returning({ id: accountSubscriptions.id });
    return requireRow(row);
  }
}
