import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DRIZZLE, type DbExecutor } from '#db/db.module.js';
import { requireRow } from '#db/require-row.js';
import * as schema from '#db/schema.js';
import {
  accounts,
  accountSubscriptions,
  stores,
  roles,
  userRoleMappings,
  locations,
} from '#db/schema.js';

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
   * Lock the account row for the duration of the transaction (SELECT ... FOR
   * UPDATE). Serializes concurrent store-creation attempts against the same
   * account so the max_stores recheck below it can't race — the second
   * transaction blocks here until the first commits (or rolls back).
   */
  async lockAccount(accountId: string, tx: DbExecutor): Promise<void> {
    await tx
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .for('update');
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

  /**
   * Active (non-locked, non-deleted) stores for an account — used by downgrade
   * delta-detection (id only) and the reconciliation resolve screen (id + name)
   * (subscription §15D, device-management §19).
   */
  async listActiveStores(accountId: string, tx?: DbExecutor): Promise<{ id: string; name: string }[]> {
    return this.client(tx)
      .select({ id: stores.id, name: stores.name })
      .from(stores)
      .where(
        and(
          eq(stores.accountFk, accountId),
          eq(stores.locked, false),
          isNull(stores.deletedAt),
        ),
      );
  }

  /**
   * Every non-deleted store for an account, locked or not — the reconciliation
   * "swap active store" endpoint needs to see a currently-locked store to
   * reactivate it, unlike `listActiveStores` which deliberately excludes them.
   */
  async listAllStores(
    accountId: string,
    tx?: DbExecutor,
  ): Promise<{ id: string; name: string; locked: boolean }[]> {
    return this.client(tx)
      .select({ id: stores.id, name: stores.name, locked: stores.locked })
      .from(stores)
      .where(and(eq(stores.accountFk, accountId), isNull(stores.deletedAt)));
  }

  /** Lock stores as downgrade-excess (reconciliation §5.1) — reversible, never deletes. */
  async lockMany(storeIds: string[], tx: DbExecutor): Promise<void> {
    if (storeIds.length === 0) return;
    await tx
      .update(stores)
      .set({ locked: true, lockedReason: 'downgrade' })
      .where(inArray(stores.id, storeIds));
  }

  /** Unlock one specific store — the reconciliation "swap active store"
   *  endpoint's targeted counterpart to `unlockDowngraded`'s account-wide bulk restore. */
  async unlockOne(storeId: string, tx: DbExecutor): Promise<void> {
    await tx
      .update(stores)
      .set({ locked: false, lockedReason: null })
      .where(eq(stores.id, storeId));
  }

  /** Re-upgrade mirror (reconciliation §9) — unlock every store this account
   *  locked for a downgrade. Nothing else is ever touched; a store locked for
   *  any other future reason wouldn't match `lockedReason='downgrade'`. */
  async unlockDowngraded(accountId: string, tx: DbExecutor): Promise<void> {
    await tx
      .update(stores)
      .set({ locked: false, lockedReason: null })
      .where(and(eq(stores.accountFk, accountId), eq(stores.lockedReason, 'downgrade')));
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
    return requireRow(row);
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
    return requireRow(row);
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
    return requireRow(row);
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

  /**
   * Fields the account-level write-gate needs before creating a store — mirrors
   * SubscriptionStatusGuard, which can't run here (no :storeId tenant context).
   */
  async findSubscriptionGate(
    accountId: string,
    tx?: DbExecutor,
  ): Promise<{ status: string; accessValidUntil: Date | null; reconciliationStatus: string } | null> {
    const [row] = await this.client(tx)
      .select({
        status:               accountSubscriptions.status,
        accessValidUntil:     accountSubscriptions.accessValidUntil,
        reconciliationStatus: accountSubscriptions.reconciliationStatus,
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
