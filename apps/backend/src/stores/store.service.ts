import { ForbiddenException, Injectable } from '@nestjs/common';
import { UnitOfWork } from '#db/db.module.js';
import { StoreRepository } from './store.repository.js';
import { EntitlementService } from '../subscription/entitlement.service.js';
import { RbacService } from '#common/rbac/rbac.service.js';
import { AuditService } from '#auth/core/audit.service.js';
import { SnapshotService } from '#auth/mobile/services/snapshot.service.js';

const TRIAL_DAYS = 15;

export interface CreateStoreInput {
  name:       string;
  gstNumber?: string;
  address?:   string;
  phone?:     string;
  email?:     string;
}

export interface CreatedStore {
  id:   string;
  name: string;
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
  ) {}

  async createStore(userId: string, input: CreateStoreInput): Promise<CreatedStore> {
    // Ownership gate — only the account owner may create stores (accounts.owner_user_fk).
    const account = await this.repo.findOwnedAccount(userId);
    if (!account) throw new ForbiddenException('NOT_ACCOUNT_OWNER');

    // max_stores gate (device F0). Locked stores don't count. Fast pre-check
    // outside the transaction for quick feedback on the common case.
    const precheckLimit = await this.entitlements.get(account.id, 'max_stores');
    const precheckActive = await this.repo.countActiveStores(account.id);
    if (!this.entitlements.canCreate(precheckLimit, precheckActive)) {
      throw new ForbiddenException('STORE_LIMIT_REACHED');
    }

    const created = await this.uow.execute(async (tx) => {
      // Lock the account row so concurrent creates serialize, then recheck the
      // gate inside the transaction — the pre-check above is TOCTOU-able by
      // itself (two concurrent requests can both pass it before either inserts).
      await this.repo.lockAccount(account.id, tx);
      const limit = await this.entitlements.get(account.id, 'max_stores', tx);
      const active = await this.repo.countActiveStores(account.id, tx);
      if (!this.entitlements.canCreate(limit, active)) {
        throw new ForbiddenException('STORE_LIMIT_REACHED');
      }

      const isFirstStore = !(await this.repo.hasAnyStore(account.id, tx));

      const store = await this.repo.insertStore(
        {
          accountFk: account.id,
          name:      input.name,
          gstNumber: input.gstNumber,
          address:   input.address,
          phone:     input.phone,
          email:     input.email,
        },
        tx,
      );

      // Per-store immutable STORE_OWNER role, fully granted, assigned to creator.
      const ownerRole = await this.repo.insertStoreOwnerRole(store.id, tx);
      await this.rbac.seedStoreOwnerPermissions(ownerRole.id, userId, tx);
      await this.repo.insertRoleMapping(
        { userFk: userId, roleFk: ownerRole.id, storeFk: store.id, assignedBy: userId },
        tx,
      );

      // Head Office location (is_primary=true, slot 1) — atomic with the store.
      await this.repo.insertHeadOffice(store.id, tx);

      // First store opens the trial window (subscription.md §1).
      if (isFirstStore) {
        const sub = await this.repo.findSubscription(account.id, tx);
        if (sub && sub.status === 'trialing' && !sub.hasUsedTrial) {
          const trialEndsAt = new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000);
          await this.repo.startTrial(sub.id, trialEndsAt, tx);
        }
      }

      // Bump so a stale JWT re-bootstraps and picks up the new store role (H-6).
      await this.repo.bumpUserPermissionsVersion(userId, tx);

      return store;
    });

    // The creator's accessible-store list + perm cache are now stale.
    await this.rbac.invalidateUserStoreCache(userId, created.id);
    // ...and so is the cached signed permission snapshot bootstrap serves —
    // without this, a client that bootstrapped before creating the store
    // keeps seeing the pre-store snapshot until SNAPSHOT_CACHE_TTL_SECONDS
    // expires, even though permissionsVersion was just bumped.
    await this.snapshot.invalidate(userId);

    await this.audit.log({
      event:        'STORE_CREATED',
      activityType: 'ROLE_ASSIGNMENT_CREATED',
      prefix:       'Store',
      suffix:       `created and STORE_OWNER assigned`,
      userId,
      storeFk:      created.id,
      isSuccess:    true,
      entityType:   'Store',
      entityId:     created.id,
    });

    return { id: created.id, name: created.name };
  }
}
