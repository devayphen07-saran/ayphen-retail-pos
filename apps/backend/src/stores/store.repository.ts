import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DRIZZLE, type DbExecutor } from '../db/db.module.js';
import * as schema from '../db/schema.js';
import {
  accounts,
  accountSubscriptions,
  stores,
  roles,
  userRoleMappings,
  locations,
} from '../db/schema.js';

@Injectable()
export class StoreRepository {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>,
  ) {}

  private client(tx?: DbExecutor) {
    return tx ?? this.db;
  }

  /** The account owned by this user (accounts.owner_user_fk). */
  async findOwnedAccount(
    userId: string,
    tx?: DbExecutor,
  ): Promise<{ id: string } | null> {
    const [row] = await this.client(tx)
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.ownerUserFk, userId));
    return row ?? null;
  }

  /**
   * Count active (non-locked, non-deleted) stores for an account — the
   * denominator of the max_stores gate (device F0). Locked stores don't count.
   */
  async countActiveStores(accountId: string, tx?: DbExecutor): Promise<number> {
    const [row] = await this.client(tx)
      .select({ n: sql<number>`count(*)::int` })
      .from(stores)
      .where(
        and(
          eq(stores.accountFk, accountId),
          eq(stores.locked, false),
          isNull(stores.deletedAt),
        ),
      );
    return row?.n ?? 0;
  }

  /** Whether the account has any store at all (used for first-store trial start). */
  async hasAnyStore(accountId: string, tx?: DbExecutor): Promise<boolean> {
    const [row] = await this.client(tx)
      .select({ n: sql<number>`count(*)::int` })
      .from(stores)
      .where(and(eq(stores.accountFk, accountId), isNull(stores.deletedAt)));
    return (row?.n ?? 0) > 0;
  }

  async insertStore(
    data: typeof stores.$inferInsert,
    tx?: DbExecutor,
  ): Promise<typeof stores.$inferSelect> {
    const [row] = await this.client(tx).insert(stores).values(data).returning();
    return row!;
  }

  /** Create the per-store immutable STORE_OWNER role. */
  async insertStoreOwnerRole(
    storeId: string,
    tx?: DbExecutor,
  ): Promise<{ id: string }> {
    const [row] = await this.client(tx)
      .insert(roles)
      .values({
        storeFk:    storeId,
        code:       'STORE_OWNER',
        name:       'Store Owner',
        isEditable: false,
      })
      .returning({ id: roles.id });
    return row!;
  }

  async insertRoleMapping(
    data: typeof userRoleMappings.$inferInsert,
    tx?: DbExecutor,
  ): Promise<void> {
    await this.client(tx).insert(userRoleMappings).values(data);
  }

  /**
   * Auto-provision the Head Office location for a new store (device §5B / §26.1).
   * is_primary=true, display_order=0 — counts as slot 1 of max_locations_per_store
   * and is immune to downgrade-locking. The uk_location_primary index guarantees
   * one per store.
   */
  async insertHeadOffice(storeId: string, tx?: DbExecutor): Promise<{ id: string }> {
    const [row] = await this.client(tx)
      .insert(locations)
      .values({
        storeFk: storeId,
        name: 'Head Office',
        isPrimary: true,
        isDefault: true,   // Head Office is also the default the device opens into (§8.2)
        displayOrder: 0,
      })
      .returning({ id: locations.id });
    return row!;
  }

  /** Read the account's subscription trial state (for first-store trial start). */
  async findSubscription(
    accountId: string,
    tx?: DbExecutor,
  ): Promise<{ id: string; status: string; hasUsedTrial: boolean } | null> {
    const [row] = await this.client(tx)
      .select({
        id: accountSubscriptions.id,
        status: accountSubscriptions.status,
        hasUsedTrial: accountSubscriptions.hasUsedTrial,
      })
      .from(accountSubscriptions)
      .where(eq(accountSubscriptions.accountFk, accountId));
    return row ?? null;
  }

  /** Open the trial window (first store). Sets trial_ends_at / access_valid_until. */
  async startTrial(
    subscriptionId: string,
    trialEndsAt: Date,
    tx?: DbExecutor,
  ): Promise<void> {
    await this.client(tx)
      .update(accountSubscriptions)
      .set({
        trialEndsAt,
        accessValidUntil: trialEndsAt,
        hasUsedTrial: true,
        subscriptionVersion: sql`${accountSubscriptions.subscriptionVersion} + 1`,
      })
      .where(eq(accountSubscriptions.id, subscriptionId));
  }

  async bumpUserPermissionsVersion(userId: string, tx?: DbExecutor): Promise<void> {
    await this.client(tx)
      .update(schema.users)
      .set({ permissionsVersion: sql`${schema.users.permissionsVersion} + 1` })
      .where(eq(schema.users.id, userId));
  }
}
