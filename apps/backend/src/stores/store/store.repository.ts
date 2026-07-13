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
  invitations,
  products,
  paymentAccounts,
  storeDeviceAccess,
  devices,
} from '#db/schema.js';

/** A store's active/locked state — the reconciliation "swap active store"
 *  flow's view of every store on an account, per `listAllStores`. */
export interface StoreSummary {
  id: string;
  name: string;
  locked: boolean;
}

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
  async listActiveStores(
    accountId: string,
    tx?: DbExecutor,
  ): Promise<{ id: string; name: string }[]> {
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
  ): Promise<StoreSummary[]> {
    return this.client(tx)
      .select({ id: stores.id, name: stores.name, locked: stores.locked })
      .from(stores)
      .where(and(eq(stores.accountFk, accountId), isNull(stores.deletedAt)));
  }

  /** Lock stores as downgrade-excess (reconciliation §5.1) — reversible, never deletes. */
  /** Scoped to `accountId` — a client-influenced store id list must never be
   *  able to lock a store belonging to a different account. */
  async lockMany(
    storeIds: string[],
    accountId: string,
    tx: DbExecutor,
  ): Promise<void> {
    if (storeIds.length === 0) return;
    await tx
      .update(stores)
      .set({ locked: true, lockedReason: 'downgrade' })
      .where(
        and(inArray(stores.id, storeIds), eq(stores.accountFk, accountId)),
      );
  }

  /** Unlock one specific store — the reconciliation "swap active store"
   *  endpoint's targeted counterpart to `unlockDowngraded`'s account-wide bulk
   *  restore. Scoped to `accountId` for the same reason as `lockMany`. */
  async unlockOne(
    storeId: string,
    accountId: string,
    tx: DbExecutor,
  ): Promise<void> {
    await tx
      .update(stores)
      .set({ locked: false, lockedReason: null })
      .where(and(eq(stores.id, storeId), eq(stores.accountFk, accountId)));
  }

  /** Re-upgrade mirror (reconciliation §9) — unlock every store this account
   *  locked for a downgrade. Nothing else is ever touched; a store locked for
   *  any other future reason wouldn't match `lockedReason='downgrade'`. */
  async unlockDowngraded(accountId: string, tx: DbExecutor): Promise<void> {
    await tx
      .update(stores)
      .set({ locked: false, lockedReason: null })
      .where(
        and(
          eq(stores.accountFk, accountId),
          eq(stores.lockedReason, 'downgrade'),
        ),
      );
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
        storeFk: storeId,
        code: 'STORE_OWNER',
        name: 'Store Owner',
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
   * Seed the two locked default payment accounts (Cash + Bank) for a new store
   * (PRD payment-accounts-mobile §BR-1/DR-2). `isSystem` locks them against
   * delete/deactivate; `systemKey` is the stable discriminator; Cash is the
   * initial default. Idempotent via `uk_payment_accounts_system_key` — a retried
   * create can't produce a second Cash/Bank — and it runs in the same transaction
   * as the store insert, so a failure rolls the whole store back.
   */
  async seedDefaultPaymentAccounts(
    storeId: string,
    userId: string,
    tx?: DbExecutor,
  ): Promise<{ cashAccountId: string | undefined; bankAccountId: string | undefined }> {
    const rows = await this.client(tx)
      .insert(paymentAccounts)
      .values([
        {
          storeFk: storeId,
          name: 'Cash',
          kind: 'cash',
          systemKey: 'cash',
          isSystem: true,
          isActive: true,
          isDefault: true,
          createdBy: userId,
        },
        {
          storeFk: storeId,
          name: 'Bank',
          kind: 'bank',
          systemKey: 'bank',
          isSystem: true,
          isActive: true,
          isDefault: false,
          createdBy: userId,
        },
      ])
      .onConflictDoNothing()
      .returning({ id: paymentAccounts.id, systemKey: paymentAccounts.systemKey });

    return {
      cashAccountId: rows.find((r) => r.systemKey === 'cash')?.id,
      bankAccountId: rows.find((r) => r.systemKey === 'bank')?.id,
    };
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
  ): Promise<{
    status: string;
    accessValidUntil: Date | null;
    reconciliationStatus: string;
  } | null> {
    const [row] = await this.client(tx)
      .select({
        status: accountSubscriptions.status,
        accessValidUntil: accountSubscriptions.accessValidUntil,
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

  async bumpUserPermissionsVersion(
    userId: string,
    tx?: DbExecutor,
  ): Promise<void> {
    await this.client(tx)
      .update(schema.users)
      .set({ permissionsVersion: sql`${schema.users.permissionsVersion} + 1` })
      .where(eq(schema.users.id, userId));
  }

  /** Profile fields the setup-status "store profile complete" check reads. */
  async findProfileFields(
    storeId: string,
  ): Promise<{
    gstNumber: string | null;
    address: string | null;
    phone: string | null;
    email: string | null;
  } | null> {
    const [row] = await this.db
      .select({
        gstNumber: stores.gstNumber,
        address: stores.address,
        phone: stores.phone,
        email: stores.email,
      })
      .from(stores)
      .where(eq(stores.id, storeId));
    return row ?? null;
  }

  /** Whether this store has any accepted (not merely pending) staff invitation. */
  async hasAcceptedInvitation(storeId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: invitations.id })
      .from(invitations)
      .where(
        and(
          eq(invitations.storeFk, storeId),
          eq(invitations.status, 'accepted'),
        ),
      )
      .limit(1);
    return !!row;
  }

  /** Whether this store has at least one active, non-deleted product. */
  async hasActiveProduct(storeId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: products.id })
      .from(products)
      .where(
        and(
          eq(products.storeFk, storeId),
          eq(products.isActive, true),
          isNull(products.deletedAt),
        ),
      )
      .limit(1);
    return !!row;
  }

  /** Whether this store has at least one active payment account configured. */
  async hasActivePaymentAccount(storeId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: paymentAccounts.id })
      .from(paymentAccounts)
      .where(
        and(
          eq(paymentAccounts.storeFk, storeId),
          eq(paymentAccounts.isActive, true),
        ),
      )
      .limit(1);
    return !!row;
  }

  /** Whether this store has at least one trusted device with an active slot.
   *  Trust lives on `devices.isTrusted`, not on the join table itself. */
  async hasTrustedDevice(storeId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: storeDeviceAccess.id })
      .from(storeDeviceAccess)
      .innerJoin(devices, eq(devices.id, storeDeviceAccess.deviceFk))
      .where(
        and(
          eq(storeDeviceAccess.storeFk, storeId),
          eq(storeDeviceAccess.status, 'active'),
          eq(devices.isTrusted, true),
        ),
      )
      .limit(1);
    return !!row;
  }
}
