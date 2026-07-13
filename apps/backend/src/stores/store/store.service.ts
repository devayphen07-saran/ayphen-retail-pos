import { Injectable } from '@nestjs/common';
import { MS_PER_DAY } from '#common/time.js';
import {
  ForbiddenError,
  PaymentRequiredError,
} from '#common/exceptions/app.exception.js';
import { ErrorCodes } from '#common/error-codes.js';
import { UnitOfWork } from '#db/db.module.js';
import { StoreRepository } from './store.repository.js';
import { EntitlementService } from '../../subscription/entitlement.service.js';
import { RbacService } from '#common/rbac/rbac.service.js';
import { AuditService } from '#common/audit/audit.service.js';
import { SnapshotService } from '#auth/mobile/services/snapshot.service.js';
import { AccountPostingService } from '../../ledger/account-posting.service.js';
import type { PermissionSnapshot } from '#common/types/permission-snapshot.js';

const TRIAL_DAYS = 15;

export interface CreateStoreInput {
  name: string;
  gstNumber?: string;
  address?: string;
  phone?: string;
  email?: string;
  /** F1 (docs/prd/accounts-and-ledger.md) — how much cash is already in the
   *  drawer today. Optional; omitted/zero starts the Cash account at 0. */
  openingCashBalancePaise?: number;
}

/** `snapshot`/`snapshotSignature` are nullable — best-effort, see `createStore`. */
export interface CreatedStore {
  id: string;
  name: string;
  snapshot: PermissionSnapshot | null;
  snapshotSignature: string | null;
}

export interface SetupStatus {
  totalChecks: number;
  completedChecks: number;
  completionPercentage: number;
  statusMap: {
    storeProfileComplete: boolean;
    staffInvited: boolean;
    productAdded: boolean;
    paymentConfigured: boolean;
    deviceLinked: boolean;
  };
}

/**
 * Store lifecycle (subscription.md §8, device F0, rbac.md §21). Creating a store
 * is an account-level action gated by ownership + max_stores — NOT by store RBAC
 * (the creator has no store role until this runs). The whole thing is one atomic
 * transaction: store + STORE_OWNER role (fully granted) + owner assignment +
 * first-store trial start + permissions-version bump.
 */
@Injectable()
export class StoreService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly repo: StoreRepository,
    private readonly entitlements: EntitlementService,
    private readonly rbac: RbacService,
    private readonly audit: AuditService,
    private readonly snapshot: SnapshotService,
    private readonly ledger: AccountPostingService,
  ) {}

  /**
   * Block store creation when the account subscription has lapsed (§ subscription
   * write-gate). Trialing with no access window yet (first store) is allowed.
   * No subscription row at all (shouldn't happen post-bootstrap) is allowed
   * through — the max_stores gate still applies.
   */
  private async assertAccountCanWrite(accountId: string): Promise<void> {
    const sub = await this.repo.findSubscriptionGate(accountId);
    if (!sub) return;

    if (sub.status === 'paused') {
      throw new ForbiddenError(
        ErrorCodes.SUBSCRIPTION_SUSPENDED,
        'Account is suspended',
      );
    }
    if (sub.status === 'expired') {
      throw new PaymentRequiredError(
        ErrorCodes.SUBSCRIPTION_PAYMENT_REQUIRED,
        'Subscription payment required',
      );
    }
    if (sub.accessValidUntil && sub.accessValidUntil < new Date()) {
      throw new PaymentRequiredError(
        ErrorCodes.SUBSCRIPTION_PAYMENT_REQUIRED,
        'Subscription payment required',
      );
    }
    if (sub.reconciliationStatus === 'pending') {
      throw new ForbiddenError(
        ErrorCodes.SUBSCRIPTION_RECONCILIATION_REQUIRED,
        'Resolve your plan downgrade before creating stores',
      );
    }
  }

  async createStore(
    userId: string,
    input: CreateStoreInput,
  ): Promise<CreatedStore> {
    // Ownership gate — only the account owner may create stores (accounts.owner_user_fk).
    const account = await this.repo.findOwnedAccount(userId);
    if (!account)
      throw new ForbiddenError(
        ErrorCodes.NOT_ACCOUNT_OWNER,
        'You are not the account owner',
      );

    // Account-level write-gate — same contract as SubscriptionStatusGuard, which
    // can't run on this store-unscoped route. A first store (trialing, no access
    // window opened yet) passes; a lapsed / paused / mid-downgrade account cannot
    // create new stores.
    await this.assertAccountCanWrite(account.id);

    // max_stores gate (device F0). Locked stores don't count. Fast pre-check
    // outside the transaction for quick feedback on the common case.
    const precheckLimit = await this.entitlements.get(account.id, 'max_stores');
    const precheckActive = await this.repo.countActiveStores(account.id);
    if (!this.entitlements.canCreate(precheckLimit, precheckActive)) {
      throw new ForbiddenError(
        ErrorCodes.STORE_LIMIT_REACHED,
        'Store limit reached for this plan',
        {
          limit: precheckLimit,
          current: precheckActive,
        },
      );
    }

    const created = await this.uow.execute(async (tx) => {
      // Lock the account row so concurrent creates serialize, then recheck the
      // gate inside the transaction — the pre-check above is TOCTOU-able by
      // itself (two concurrent requests can both pass it before either inserts).
      await this.repo.lockAccount(account.id, tx);
      const limit = await this.entitlements.get(account.id, 'max_stores', tx);
      const active = await this.repo.countActiveStores(account.id, tx);
      if (!this.entitlements.canCreate(limit, active)) {
        throw new ForbiddenError(
          ErrorCodes.STORE_LIMIT_REACHED,
          'Store limit reached for this plan',
          {
            limit,
            current: active,
          },
        );
      }

      const isFirstStore = !(await this.repo.hasAnyStore(account.id, tx));

      const store = await this.repo.insertStore(
        {
          accountFk: account.id,
          name: input.name,
          gstNumber: input.gstNumber,
          address: input.address,
          phone: input.phone,
          email: input.email,
        },
        tx,
      );

      // Seed the two locked default payment accounts (Cash + Bank) so the store
      // can take payment from day one (PRD payment-accounts-mobile §BR-1). Same
      // transaction as the store insert → a seed failure rolls the store back.
      const seeded = await this.repo.seedDefaultPaymentAccounts(store.id, userId, tx);

      // F1 (docs/prd/accounts-and-ledger.md): an owner who tells us how much
      // cash is already in the drawer gets a store whose balance starts right,
      // not at zero. Same transaction as the seed — a posting failure rolls
      // the whole store back same as any other step here.
      if (input.openingCashBalancePaise && input.openingCashBalancePaise > 0 && seeded.cashAccountId) {
        await this.ledger.recordOpeningBalance(tx, {
          storeFk: store.id,
          accountFk: seeded.cashAccountId,
          amountPaise: input.openingCashBalancePaise,
          userId,
        });
      }

      // Per-store immutable STORE_OWNER role, fully granted, assigned to creator.
      const ownerRole = await this.repo.insertStoreOwnerRole(store.id, tx);
      await this.rbac.seedStoreOwnerPermissions(ownerRole.id, userId, tx);
      await this.repo.insertRoleMapping(
        {
          userFk: userId,
          roleFk: ownerRole.id,
          storeFk: store.id,
          assignedBy: userId,
        },
        tx,
      );

      // First store opens the trial window (subscription.md §1).
      if (isFirstStore) {
        const sub = await this.repo.findSubscription(account.id, tx);
        if (sub && sub.status === 'trialing' && !sub.hasUsedTrial) {
          const trialEndsAt = new Date(Date.now() + TRIAL_DAYS * MS_PER_DAY);
          await this.repo.startTrial(sub.id, trialEndsAt, tx);
        }
      }

      // Bump so a stale JWT re-bootstraps and picks up the new store role (H-6).
      await this.repo.bumpUserPermissionsVersion(userId, tx);

      await this.audit.logInTransaction(
        {
          event: 'STORE_CREATED',
          activityType: 'ROLE_ASSIGNMENT_CREATED',
          prefix: 'Store',
          suffix: `created and STORE_OWNER assigned`,
          userId,
          storeFk: store.id,
          isSuccess: true,
          entityType: 'Store',
          entityId: store.id,
        },
        tx,
      );

      return store;
    });

    // The creator's accessible-store list + perm cache are now stale.
    await this.rbac.invalidateUserStoreCache(userId, created.id);
    // ...and so is the cached signed permission snapshot bootstrap serves.
    // Invalidate it and embed the rebuilt snapshot so the client can patch its
    // session state in place instead of a full bootstrap round trip (best-effort
    // — a build failure leaves these null and the client falls back to bootstrap).
    const { snapshot, snapshotSignature } =
      await this.snapshot.invalidateAndRebuild(userId);

    return { id: created.id, name: created.name, snapshot, snapshotSignature };
  }

  /**
   * Computed on the fly, never persisted — five independent existence checks
   * run concurrently (each hits a different indexed table, so there's no
   * benefit to sequencing them).
   */
  async getSetupStatus(storeId: string): Promise<SetupStatus> {
    const [
      profile,
      staffInvited,
      productAdded,
      paymentConfigured,
      deviceLinked,
    ] = await Promise.all([
      this.repo.findProfileFields(storeId),
      this.repo.hasAcceptedInvitation(storeId),
      this.repo.hasActiveProduct(storeId),
      this.repo.hasActivePaymentAccount(storeId),
      this.repo.hasTrustedDevice(storeId),
    ]);

    const statusMap = {
      storeProfileComplete: !!(
        profile?.gstNumber &&
        profile?.address &&
        profile?.phone &&
        profile?.email
      ),
      staffInvited,
      productAdded,
      paymentConfigured,
      deviceLinked,
    };

    const totalChecks = Object.keys(statusMap).length;
    const completedChecks = Object.values(statusMap).filter(Boolean).length;

    return {
      totalChecks,
      completedChecks,
      completionPercentage: Math.round((completedChecks / totalChecks) * 100),
      statusMap,
    };
  }
}
