import { Inject, Injectable } from '@nestjs/common';
import {
  ForbiddenError,
  UnprocessableError,
} from '#common/exceptions/app.exception.js';
import { ErrorCodes } from '#common/error-codes.js';
import type { Redis } from 'ioredis';
import { UnitOfWork, type DbExecutor } from '#db/db.module.js';
import { REDIS } from '#common/redis/redis.provider.js';
import { SubscriptionRepository } from './subscription.repository.js';
import { EntitlementService } from './entitlement.service.js';
import { subVersionPointerKey } from './subscription-cache.js';
import { StoreRepository, type StoreSummary } from '../stores/store/store.repository.js';
import { LocationRepository, type Location } from '../locations/location.repository.js';
import { DeviceAccessRepository, type StoreDeviceRow } from '../devices/device-access.repository.js';
import { InvitationRepository } from '../stores/invitation/invitation.repository.js';

export interface ReconciliationLimits {
  maxStores: number | null;
  maxLocations: number | null;
  maxDevices: number | null;
  /** Per-store limit (subscription §15D). Unlike stores/locations/devices,
   *  there is no pick-list of staff to keep here — the owner resolves a
   *  staff overage through the existing team-management screen
   *  (RoleService.revokeRole), and `validate()`/`validateSwap()` simply
   *  block apply() until every kept store is back under this limit. */
  maxUsers: number | null;
}

export interface ReconciliationStoreInfo {
  id: string;
  name: string;
  locationCount: number;
  deviceCount: number;
  userCount: number;
}

export interface ReconciliationLocationInfo {
  id: string;
  storeId: string;
  name: string;
  isPrimary: boolean;
}

export interface ReconciliationDeviceInfo {
  id: string;
  storeId: string;
  label: string | null;
  model: string | null;
  platform: string;
  lastAccessedAt: Date;
  isCurrentDevice: boolean;
}

export interface ReconciliationContext {
  limits: ReconciliationLimits;
  stores: ReconciliationStoreInfo[];
  locations: ReconciliationLocationInfo[];
  devices: ReconciliationDeviceInfo[];
}

export interface ReconciliationSelection {
  keepStoreIds: string[];
  keepLocationIds: string[];
  keepDeviceIds: string[];
}

export interface ActiveStoreSwap {
  activateStoreId: string;
  deactivateStoreId: string;
  /** Location/device choices for `activateStoreId` only — every other kept
   *  store's own selection is untouched by a swap. */
  keepLocationIds: string[];
  keepDeviceIds: string[];
}

/**
 * The owner's downgrade resolution (subscription §15D, device-management §19,
 * this session's downgrade-reconciliation design). Once a plan change leaves
 * the account over limit (`reconciliation_status='pending'`, set by
 * `DowngradeDetectionService` from `SubscriptionService.activateFromPayment`),
 * every write is blocked until the owner picks what to keep here — never
 * auto-picked, never deleted, only locked/revoked (fully reversible).
 *
 * Head Office is immune from location-locking (it can never be disabled or
 * deleted elsewhere in the app either) — it is not offered as a choice and is
 * never included in `locations` for a store where it's the only location that
 * must survive; the owner only picks among the *rest*.
 */
@Injectable()
export class ReconciliationService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly subscriptions: SubscriptionRepository,
    private readonly entitlements: EntitlementService,
    private readonly stores: StoreRepository,
    private readonly locations: LocationRepository,
    private readonly devices: DeviceAccessRepository,
    private readonly invitations: InvitationRepository,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /** Duplicated from SubscriptionService.invalidateCache rather than injecting
   *  that service — SubscriptionService.activateFromPayment needs to call
   *  INTO this service (the re-upgrade mirror below), so this service can't
   *  depend back on it without a circular provider graph. Same cache-key
   *  scheme, same best-effort semantics (TTL is the backstop). */
  private async invalidateCache(accountId: string): Promise<void> {
    try {
      await this.redis.del(subVersionPointerKey(accountId));
    } catch {
      // Best-effort; TTL is the backstop.
    }
  }

  /** Read-only snapshot for the resolve screen — every active store/location/
   *  device the owner can choose to keep, plus the plan's new limits. */
  async getContextForUser(
    userId: string,
    currentDeviceId: string,
  ): Promise<ReconciliationContext> {
    const accountId = await this.requireOwnedAccountId(userId);
    return this.getContext(accountId, currentDeviceId);
  }

  /**
   * Batched across stores — one query per resource type for the whole
   * account instead of N sequential per-store queries. Accepts an optional
   * `tx` so `apply()` can call this AFTER taking `lockAccount`, re-reading
   * live state under the lock rather than deciding what to lock/revoke from
   * a snapshot taken before the lock was held.
   */
  private async getContext(
    accountId: string,
    currentDeviceId: string,
    tx?: DbExecutor,
  ): Promise<ReconciliationContext> {
    const [maxStores, maxLocations, maxDevices, maxUsers] = await Promise.all([
      this.entitlements.get(accountId, 'max_stores', tx),
      this.entitlements.get(accountId, 'max_locations_per_store', tx),
      this.entitlements.get(accountId, 'max_devices_per_store', tx),
      this.entitlements.get(accountId, 'max_users_per_store', tx),
    ]);

    const activeStores = await this.stores.listActiveStores(accountId, tx);
    const storeIds = activeStores.map((s) => s.id);

    const [allLocations, allDevices, userCounts] = await Promise.all([
      this.locations.listActiveByStores(storeIds, tx),
      this.devices.listStoreDevicesByStores(storeIds, tx),
      this.invitations.countActiveStaffByStores(storeIds, tx),
    ]);
    const activeDevices = allDevices.filter((d) => d.status === 'active');

    const locationsByStore = new Map<string, typeof allLocations>();
    for (const l of allLocations) {
      const list = locationsByStore.get(l.storeFk) ?? [];
      list.push(l);
      locationsByStore.set(l.storeFk, list);
    }
    const devicesByStore = new Map<string, typeof activeDevices>();
    for (const d of activeDevices) {
      const list = devicesByStore.get(d.storeFk) ?? [];
      list.push(d);
      devicesByStore.set(d.storeFk, list);
    }

    const storeInfos: ReconciliationStoreInfo[] = activeStores.map((store) => ({
      id: store.id,
      name: store.name,
      locationCount: locationsByStore.get(store.id)?.length ?? 0,
      deviceCount: devicesByStore.get(store.id)?.length ?? 0,
      userCount: userCounts.get(store.id) ?? 0,
    }));
    const locationInfos: ReconciliationLocationInfo[] = allLocations.map(
      (l) => ({
        id: l.id,
        storeId: l.storeFk,
        name: l.name,
        isPrimary: l.isPrimary,
      }),
    );
    const deviceInfos: ReconciliationDeviceInfo[] = activeDevices.map((d) => ({
      id: d.deviceFk,
      storeId: d.storeFk,
      label: d.deviceLabel,
      model: d.model,
      platform: d.platform,
      lastAccessedAt: d.lastAccessedAt,
      isCurrentDevice: d.deviceFk === currentDeviceId,
    }));

    return {
      limits: { maxStores, maxLocations, maxDevices, maxUsers },
      stores: storeInfos,
      locations: locationInfos,
      devices: deviceInfos,
    };
  }

  /**
   * Validate + apply the owner's selection in one transaction (Step 4/5 of the
   * design): every store not kept gets locked; within each kept store, every
   * location/device not kept gets locked/revoked. Head Office is always kept
   * implicitly (never locked) regardless of what the owner picked — it isn't
   * in `ctx.locations` as a lockable candidate to begin with here since it's
   * simply never a member of the "excess" set below.
   */
  async applyForUser(
    userId: string,
    currentDeviceId: string,
    selection: ReconciliationSelection,
  ): Promise<void> {
    const accountId = await this.requireOwnedAccountId(userId);
    return this.apply(accountId, userId, currentDeviceId, selection);
  }

  private async apply(
    accountId: string,
    actorId: string,
    currentDeviceId: string,
    selection: ReconciliationSelection,
  ): Promise<void> {
    await this.uow.execute(async (tx) => {
      // Same row lock swapActiveStoreForUser takes, for the same reason: without
      // it, two concurrent apply()/apply() or apply()/swap() calls for this
      // account read+validate against independent snapshots and can both commit,
      // leaving the account over its plan limits with neither call erroring.
      await this.stores.lockAccount(accountId, tx);

      // Re-read live state AFTER the lock, not before — deciding what to
      // lock/revoke from a pre-lock snapshot would let a store/location/device
      // created in the window between the read and the lock silently escape
      // this decision (matches swapActiveStoreForUser's lock-then-read order).
      const ctx = await this.getContext(accountId, currentDeviceId, tx);
      this.validate(ctx, selection);

      const keepStores = new Set(selection.keepStoreIds);
      const keepLocations = new Set(selection.keepLocationIds);
      const keepDevices = new Set(selection.keepDeviceIds);

      const lockStoreIds = ctx.stores
        .map((s) => s.id)
        .filter((id) => !keepStores.has(id));
      await this.stores.lockMany(lockStoreIds, accountId, tx);

      for (const store of ctx.stores) {
        if (!keepStores.has(store.id)) continue; // whole store already locked above

        const storeLocations = ctx.locations.filter(
          (l) => l.storeId === store.id,
        );
        const lockLocationIds = storeLocations
          .filter((l) => !l.isPrimary && !keepLocations.has(l.id))
          .map((l) => l.id);
        await this.locations.lockMany(lockLocationIds, tx);

        const storeDevices = ctx.devices.filter((d) => d.storeId === store.id);
        for (const device of storeDevices) {
          if (keepDevices.has(device.id)) continue;
          await this.devices.revokeSlot(
            store.id,
            device.id,
            actorId,
            'plan_downgrade',
            tx,
          );
        }
      }

      await this.subscriptions.applyTransition(
        accountId,
        {
          reconciliationStatus: 'applied',
          reconciliationEffectiveAt: new Date(),
        },
        tx,
      );

      await this.subscriptions.enqueueOutbox(
        accountId,
        'DOWNGRADE_RECONCILED',
        {
          keepStoreIds: selection.keepStoreIds,
          keepLocationIds: selection.keepLocationIds,
          keepDeviceIds: selection.keepDeviceIds,
        },
        tx,
      );
    });

    // Post-commit, like SubscriptionService.transact — never inside the txn.
    await this.invalidateCache(accountId);
  }

  /**
   * Re-upgrade mirror (Step 9 of the design). Called from
   * SubscriptionService.activateFromPayment, in the SAME transaction as the
   * plan change, whenever the new plan no longer leaves the account over
   * limit. Nothing was ever deleted, so the restore is exact: unlock every
   * store/location this service locked for `reason='downgrade'`, and
   * re-activate every device slot it revoked for `reason='plan_downgrade'`
   * (skipping any slot whose device already re-claimed a fresh one in the
   * meantime — that device moved on, don't resurrect a stale duplicate).
   *
   * Deliberately all-or-nothing: this only runs when
   * `DowngradeDetectionService.isOverLimit` is false for the WHOLE account,
   * so every previously-locked/revoked row is safe to restore unconditionally
   * — there's no partial-restore case to reason about here.
   */
  async autoRestore(accountId: string, tx: DbExecutor): Promise<void> {
    await this.stores.unlockDowngraded(accountId, tx);
    const activeStores = await this.stores.listActiveStores(accountId, tx);
    for (const store of activeStores) {
      await this.locations.unlockDowngraded(store.id, tx);
      await this.devices.restoreDowngradedSlots(store.id, tx);
    }
    await this.subscriptions.applyTransition(
      accountId,
      {
        reconciliationStatus: 'none',
        reconciliationEffectiveAt: null,
      },
      tx,
    );
  }

  /**
   * Post-downgrade flexibility (Step 8 of the design): while an account still
   * has locked-excess stores, the owner can swap which one is active — lock
   * the current one, unlock a different one — without going through the full
   * resolve flow again. Reversible, same as everything else here.
   *
   * Unlike `apply()`, this reaches into an ALREADY-locked store (the resolve
   * screen's context only ever shows currently-active resources), so it
   * fetches its own state directly rather than reusing `getContext`.
   *
   * Scope note: the self-lockout guard in `validate()` only covers the
   * resolve flow's device list; a swap that deactivates the store the
   * caller's current device is registered to isn't specifically guarded here
   * beyond what `keepDeviceIds` the caller passes for `activateStoreId` —
   * the caller is responsible for not locking themselves out via this path.
   */
  async swapActiveStoreForUser(
    userId: string,
    swap: ActiveStoreSwap,
  ): Promise<void> {
    const accountId = await this.requireOwnedAccountId(userId);

    await this.uow.execute(async (tx) => {
      // Lock the account first (same row StoreService.createStore locks) so a
      // concurrent swap/create/apply for this account serializes with this
      // one — every read below is taken AFTER the lock, so the limit checks
      // can't be validated against a snapshot that a racing request then
      // invalidates before either commits.
      await this.stores.lockAccount(accountId, tx);

      const { allStores, limits, targetLocations, targetDevices, targetUserCount } =
        await this.loadSwapContext(accountId, swap, tx);
      this.validateSwap(allStores, swap, limits, targetLocations, targetDevices, targetUserCount);
      await this.applySwap(accountId, userId, swap, targetLocations, targetDevices, tx);
    });

    await this.invalidateCache(accountId);
  }

  /** Every read `validateSwap`/`applySwap` need — taken AFTER `lockAccount`
   *  so the limit checks below can't validate against a snapshot a racing
   *  request then invalidates before either commits. */
  private async loadSwapContext(
    accountId: string,
    swap: ActiveStoreSwap,
    tx: DbExecutor,
  ): Promise<{
    allStores: StoreSummary[];
    limits: ReconciliationLimits;
    targetLocations: Location[];
    targetDevices: StoreDeviceRow[];
    targetUserCount: number;
  }> {
    const [allStores, maxStores, maxLocations, maxDevices, maxUsers, targetLocations, targetDevices, targetUserCount] =
      await Promise.all([
        this.stores.listAllStores(accountId, tx),
        this.entitlements.get(accountId, 'max_stores', tx),
        this.entitlements.get(accountId, 'max_locations_per_store', tx),
        this.entitlements.get(accountId, 'max_devices_per_store', tx),
        this.entitlements.get(accountId, 'max_users_per_store', tx),
        this.locations.listActive(swap.activateStoreId, tx),
        this.devices.listStoreDevices(swap.activateStoreId, tx),
        this.invitations.countActiveStaff(swap.activateStoreId, tx),
      ]);

    return {
      allStores,
      limits: { maxStores, maxLocations, maxDevices, maxUsers },
      targetLocations,
      targetDevices,
      targetUserCount,
    };
  }

  /**
   * Server-side re-validation (never trust the client), mirroring `validate()`
   * for the resolve flow: the deactivate/activate stores must genuinely be in
   * the state the swap implies, every kept id must belong to the target
   * store, and post-swap counts must still fit the plan's limits.
   */
  private validateSwap(
    allStores: StoreSummary[],
    swap: ActiveStoreSwap,
    limits: ReconciliationLimits,
    targetLocations: Location[],
    targetDevices: StoreDeviceRow[],
    targetUserCount: number,
  ): void {
    const deactivate = allStores.find((s) => s.id === swap.deactivateStoreId);
    const activate = allStores.find((s) => s.id === swap.activateStoreId);
    if (!deactivate || deactivate.locked) {
      throw new UnprocessableError(
        ErrorCodes.DEACTIVATE_STORE_NOT_ACTIVE,
        'The store to deactivate is not active',
      );
    }
    if (!activate || !activate.locked) {
      throw new UnprocessableError(
        ErrorCodes.ACTIVATE_STORE_NOT_LOCKED,
        'The store to activate is not locked',
      );
    }

    const activeCount = allStores.filter((s) => !s.locked).length; // unchanged by a 1-for-1 swap
    if (limits.maxStores !== null && activeCount > limits.maxStores) {
      throw new UnprocessableError(
        ErrorCodes.OVER_STORE_LIMIT,
        'Active stores exceed the plan limit',
      );
    }

    const targetLocationIds = new Set(targetLocations.map((l) => l.id));
    const targetDeviceIds = new Set(targetDevices.map((d) => d.deviceFk));

    if (swap.keepLocationIds.some((id) => !targetLocationIds.has(id))) {
      throw new UnprocessableError(
        ErrorCodes.UNKNOWN_LOCATION,
        'One or more locations do not belong to the target store',
      );
    }
    if (swap.keepDeviceIds.some((id) => !targetDeviceIds.has(id))) {
      throw new UnprocessableError(
        ErrorCodes.UNKNOWN_DEVICE,
        'One or more devices do not belong to the target store',
      );
    }

    const keptLocationCount = targetLocations.filter(
      (l) => l.isPrimary || swap.keepLocationIds.includes(l.id),
    ).length;
    if (limits.maxLocations !== null && keptLocationCount > limits.maxLocations) {
      throw new UnprocessableError(
        ErrorCodes.OVER_LOCATION_LIMIT,
        'Kept locations exceed the plan limit',
      );
    }
    if (limits.maxDevices !== null && swap.keepDeviceIds.length > limits.maxDevices) {
      throw new UnprocessableError(
        ErrorCodes.OVER_DEVICE_LIMIT,
        'Kept devices exceed the plan limit',
      );
    }

    // Same reasoning as validate()'s staff check: there is no pick-list for
    // staff, so a store that's over on max_users_per_store can never become a
    // valid swap target until the owner reduces staff there directly
    // (RoleService.revokeRole) — swapping it in would silently re-activate
    // an over-limit store.
    if (limits.maxUsers !== null && targetUserCount > limits.maxUsers) {
      throw new UnprocessableError(
        ErrorCodes.OVER_USER_LIMIT,
        'The store to activate has more staff than your plan allows',
      );
    }
  }

  /** The mutation phase — lock/unlock the swapped stores, lock/unlock the
   *  target store's locations, restore/revoke its device slots, and enqueue
   *  the outbox event. Assumes `validateSwap` already passed. */
  private async applySwap(
    accountId: string,
    userId: string,
    swap: ActiveStoreSwap,
    targetLocations: Location[],
    targetDevices: StoreDeviceRow[],
    tx: DbExecutor,
  ): Promise<void> {
    await this.stores.lockMany([swap.deactivateStoreId], accountId, tx);
    await this.stores.unlockOne(swap.activateStoreId, accountId, tx);

    const lockLocationIds = targetLocations
      .filter((l) => !l.isPrimary && !swap.keepLocationIds.includes(l.id))
      .map((l) => l.id);
    await this.locations.lockMany(lockLocationIds, tx);
    await this.locations.unlockMany(swap.keepLocationIds, tx);

    for (const device of targetDevices) {
      if (swap.keepDeviceIds.includes(device.deviceFk)) {
        await this.devices.restoreSlot(
          swap.activateStoreId,
          device.deviceFk,
          tx,
        );
      } else if (device.status === 'active') {
        await this.devices.revokeSlot(
          swap.activateStoreId,
          device.deviceFk,
          userId,
          'plan_downgrade',
          tx,
        );
      }
    }

    await this.subscriptions.enqueueOutbox(
      accountId,
      'DOWNGRADE_ACTIVE_STORE_SWAPPED',
      {
        activateStoreId: swap.activateStoreId,
        deactivateStoreId: swap.deactivateStoreId,
      },
      tx,
    );
  }

  /**
   * Server-side re-validation (never trust the client, Step 4). Every id must
   * genuinely belong to this account/store; counts must fit the new limits;
   * every surviving store keeps at least one location (Head Office always
   * counts, so this can never actually fail on its own); the owner's current
   * device is never allowed to be dropped — that would sign them out of the
   * only surface they could use to fix it.
   */
  private validate(
    ctx: ReconciliationContext,
    selection: ReconciliationSelection,
  ): void {
    const storeIds = new Set(ctx.stores.map((s) => s.id));
    const locationIds = new Set(ctx.locations.map((l) => l.id));
    const deviceIds = new Set(ctx.devices.map((d) => d.id));

    const fieldErrors: Record<string, string> = {};

    if (selection.keepStoreIds.some((id) => !storeIds.has(id))) {
      fieldErrors.keepStoreIds = "One or more selected stores don't exist.";
    } else if (
      ctx.limits.maxStores !== null &&
      selection.keepStoreIds.length > ctx.limits.maxStores
    ) {
      fieldErrors.keepStoreIds = `You've selected more stores than your plan allows (max ${ctx.limits.maxStores}).`;
    }

    if (selection.keepLocationIds.some((id) => !locationIds.has(id))) {
      fieldErrors.keepLocationIds = "One or more selected locations don't exist.";
    }
    if (selection.keepDeviceIds.some((id) => !deviceIds.has(id))) {
      fieldErrors.keepDeviceIds = "One or more selected devices don't exist.";
    }

    if (!fieldErrors.keepStoreIds) {
      const keepStores = new Set(selection.keepStoreIds);
      for (const store of ctx.stores) {
        if (!keepStores.has(store.id)) continue;

        const storeLocations = ctx.locations.filter(
          (l) => l.storeId === store.id,
        );
        const keptLocations = storeLocations.filter(
          (l) => l.isPrimary || selection.keepLocationIds.includes(l.id),
        );
        if (
          ctx.limits.maxLocations !== null &&
          keptLocations.length > ctx.limits.maxLocations
        ) {
          fieldErrors.keepLocationIds = `${store.name} has more kept locations than your plan allows (max ${ctx.limits.maxLocations} per store).`;
        }

        const storeDevices = ctx.devices.filter((d) => d.storeId === store.id);
        const keptDevices = storeDevices.filter((d) =>
          selection.keepDeviceIds.includes(d.id),
        );
        if (
          ctx.limits.maxDevices !== null &&
          keptDevices.length > ctx.limits.maxDevices
        ) {
          fieldErrors.keepDeviceIds = `${store.name} has more kept devices than your plan allows (max ${ctx.limits.maxDevices} per store).`;
        }

        // No pick-list for staff (unlike locations/devices) — the owner must
        // remove staff via the team-management screen (RoleService.revokeRole)
        // before this can be applied. Block outright rather than silently
        // flipping reconciliation_status to 'applied' while a kept store is
        // still over its staff limit (P1 gap: this axis was previously
        // unchecked here, so apply() could succeed unconditionally).
        if (
          ctx.limits.maxUsers !== null &&
          store.userCount > ctx.limits.maxUsers
        ) {
          fieldErrors.staffLimit = `${store.name} has ${store.userCount} staff, which is more than your plan allows (max ${ctx.limits.maxUsers} per store). Remove staff before continuing.`;
        }
      }
    }

    // Self-lockout guard (BR-DEV-005-equivalent), checked unconditionally
    // against every device — not just those in a kept store. Dropping the
    // owner's current device by excluding its WHOLE STORE is just as much a
    // lockout as excluding the device within a kept store; both must be
    // caught, or an owner using the app on the store they just deselected
    // signs themselves out with no guard firing (the bug this replaces).
    const current = ctx.devices.find((d) => d.isCurrentDevice);
    if (current) {
      const currentStoreKept = selection.keepStoreIds.includes(current.storeId);
      const currentDeviceKept = selection.keepDeviceIds.includes(current.id);
      if (!currentStoreKept || !currentDeviceKept) {
        fieldErrors.keepDeviceIds =
          "You can't remove the store or device you're currently using — you'd be signed out with no way back in.";
      }
    }

    if (Object.keys(fieldErrors).length > 0) {
      throw new UnprocessableError(
        ErrorCodes.RECONCILIATION_INVALID,
        'Reconciliation selection is invalid',
        { fieldErrors },
      );
    }
  }

  /** Resolving/resolving-a-downgrade is an owner-only billing action, same
   *  gate as SubscriptionService.cancel/reactivate. */
  private async requireOwnedAccountId(userId: string): Promise<string> {
    const accountId = await this.subscriptions.findOwnedAccountId(userId);
    if (!accountId)
      throw new ForbiddenError(
        ErrorCodes.NOT_ACCOUNT_OWNER,
        'You are not the account owner',
      );
    return accountId;
  }
}
