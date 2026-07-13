import { Inject, Injectable } from '@nestjs/common';
import {
  UnprocessableError,
} from '#common/exceptions/app.exception.js';
import { ErrorCodes } from '#common/error-codes.js';
import type { Redis } from 'ioredis';
import { UnitOfWork, type DbExecutor } from '#db/db.module.js';
import { REDIS } from '#common/redis/redis.provider.js';
import { SubscriptionRepository, type AccountSubscription } from './subscription.repository.js';
import { EntitlementService } from './entitlement.service.js';
import { subVersionPointerKey } from './subscription-cache.js';
import { StoreRepository, type StoreSummary } from '../stores/store/store.repository.js';
import { DeviceAccessRepository, type StoreDeviceRow } from '../devices/device-access.repository.js';

export interface ReconciliationLimits {
  maxStores: number | null;
  maxDevices: number | null;
}

export interface ReconciliationStoreInfo {
  id: string;
  name: string;
  deviceCount: number;
}

export interface ReconciliationDeviceInfo {
  /**
   * The slot's own id (storeDeviceAccess.id), NOT the device identity id.
   * A single physical device can hold active slots in more than one store at
   * once — keying by device identity would make it impossible to keep a
   * device in one store while dropping it from another, since the same id
   * would appear (and have to be treated identically) in every store's list.
   * Keying by slot id makes every entry unambiguous to exactly one store.
   */
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
  devices: ReconciliationDeviceInfo[];
}

export interface ReconciliationSelection {
  keepStoreIds: string[];
  /** Slot ids (ReconciliationDeviceInfo.id), not device identity ids. */
  keepDeviceIds: string[];
}

export interface ActiveStoreSwap {
  activateStoreId: string;
  deactivateStoreId: string;
  /** Device choices for `activateStoreId` only — every other kept
   *  store's own selection is untouched by a swap. */
  keepDeviceIds: string[];
}

/**
 * The owner's downgrade resolution (subscription §15D, device-management §19,
 * this session's downgrade-reconciliation design). Once a plan change leaves
 * the account over limit (`reconciliation_status='pending'`, set by
 * `DowngradeDetectionService` from `SubscriptionService.activateFromPayment`),
 * every write is blocked until the owner picks what to keep here — never
 * auto-picked, never deleted, only locked/revoked (fully reversible).
 */
@Injectable()
export class ReconciliationService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly subscriptions: SubscriptionRepository,
    private readonly entitlements: EntitlementService,
    private readonly stores: StoreRepository,
    private readonly devices: DeviceAccessRepository,
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

  /** Read-only snapshot for the resolve screen — every active store/device the
   *  owner can choose to keep, plus the plan's new limits. */
  async getContextForUser(
    userId: string,
    currentDeviceId: string,
  ): Promise<ReconciliationContext> {
    const accountId = await this.subscriptions.requireOwnedAccountId(userId);
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
    const [maxStores, maxDevices] = await Promise.all([
      this.entitlements.get(accountId, 'max_stores', tx),
      this.entitlements.get(accountId, 'max_devices_per_store', tx),
    ]);

    const activeStores = await this.stores.listActiveStores(accountId, tx);
    const storeIds = activeStores.map((s) => s.id);

    const allDevices = await this.devices.listStoreDevicesByStores(storeIds, tx);
    const activeDevices = allDevices.filter((d) => d.status === 'active');

    const devicesByStore = new Map<string, typeof activeDevices>();
    for (const d of activeDevices) {
      const list = devicesByStore.get(d.storeFk) ?? [];
      list.push(d);
      devicesByStore.set(d.storeFk, list);
    }

    const storeInfos: ReconciliationStoreInfo[] = activeStores.map((store) => ({
      id: store.id,
      name: store.name,
      deviceCount: devicesByStore.get(store.id)?.length ?? 0,
    }));
    const deviceInfos: ReconciliationDeviceInfo[] = activeDevices.map((d) => ({
      id: d.id, // slot id, not device identity — see ReconciliationDeviceInfo
      storeId: d.storeFk,
      label: d.deviceLabel,
      model: d.model,
      platform: d.platform,
      lastAccessedAt: d.lastAccessedAt,
      isCurrentDevice: d.deviceFk === currentDeviceId,
    }));

    return {
      limits: { maxStores, maxDevices },
      stores: storeInfos,
      devices: deviceInfos,
    };
  }

  /**
   * Validate + apply the owner's selection in one transaction (Step 4/5 of the
   * design): every store not kept gets locked; within each kept store, every
   * device not kept gets revoked.
   */
  async applyForUser(
    userId: string,
    currentDeviceId: string,
    selection: ReconciliationSelection,
  ): Promise<void> {
    const accountId = await this.subscriptions.requireOwnedAccountId(userId);
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
      // lock/revoke from a pre-lock snapshot would let a store/device
      // created in the window between the read and the lock silently escape
      // this decision (matches swapActiveStoreForUser's lock-then-read order).
      const ctx = await this.getContext(accountId, currentDeviceId, tx);
      this.validate(ctx, selection);

      const keepStores = new Set(selection.keepStoreIds);
      const keepDevices = new Set(selection.keepDeviceIds);

      const lockStoreIds = ctx.stores
        .map((s) => s.id)
        .filter((id) => !keepStores.has(id));
      await this.stores.lockMany(lockStoreIds, accountId, tx);

      for (const store of ctx.stores) {
        if (!keepStores.has(store.id)) continue; // whole store already locked above

        const storeDevices = ctx.devices.filter((d) => d.storeId === store.id);
        for (const device of storeDevices) {
          if (keepDevices.has(device.id)) continue;
          // device.id is the slot id here (see ReconciliationDeviceInfo) —
          // revoke it directly rather than by (storeId, deviceFk), which
          // would ambiguously match the SAME device's slot in another store.
          await this.devices.revokeSlotById(
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
   * store this service locked for `reason='downgrade'`, and re-activate every
   * device slot it revoked for `reason='plan_downgrade'`
   * (skipping any slot whose device already re-claimed a fresh one in the
   * meantime — that device moved on, don't resurrect a stale duplicate).
   *
   * Deliberately all-or-nothing: this only runs when
   * `DowngradeDetectionService.isOverLimit` is false for the WHOLE account,
   * so every previously-locked/revoked row is safe to restore unconditionally
   * — there's no partial-restore case to reason about here.
   */
  async autoRestore(accountId: string, tx: DbExecutor): Promise<AccountSubscription> {
    await this.stores.unlockDowngraded(accountId, tx);
    const activeStores = await this.stores.listActiveStores(accountId, tx);
    for (const store of activeStores) {
      await this.devices.restoreDowngradedSlots(store.id, tx);
    }
    const restored = await this.subscriptions.applyTransition(
      accountId,
      {
        reconciliationStatus: 'none',
        reconciliationEffectiveAt: null,
      },
      tx,
    );
    // Durable audit trail for access coming back automatically — the manual
    // resolve path (apply(), above) logs DOWNGRADE_RECONCILED; this restore
    // is billing-adjacent too (triggered by a plan upgrade) and had no event
    // of its own until now (backend-standard review finding).
    await this.subscriptions.enqueueOutbox(
      accountId,
      'DOWNGRADE_AUTO_RESTORED',
      { version: restored.subscriptionVersion },
      tx,
    );
    return restored;
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
   */
  async swapActiveStoreForUser(
    userId: string,
    currentDeviceId: string,
    swap: ActiveStoreSwap,
  ): Promise<void> {
    const accountId = await this.subscriptions.requireOwnedAccountId(userId);

    await this.uow.execute(async (tx) => {
      // Lock the account first (same row StoreService.createStore locks) so a
      // concurrent swap/create/apply for this account serializes with this
      // one — every read below is taken AFTER the lock, so the limit checks
      // can't be validated against a snapshot that a racing request then
      // invalidates before either commits.
      await this.stores.lockAccount(accountId, tx);

      const { allStores, limits, targetDevices, currentDeviceStoreIds } =
        await this.loadSwapContext(accountId, currentDeviceId, swap, tx);
      this.validateSwap(allStores, swap, limits, targetDevices, currentDeviceId, currentDeviceStoreIds);
      await this.applySwap(accountId, userId, swap, targetDevices, tx);
    });

    await this.invalidateCache(accountId);
  }

  /** Every read `validateSwap`/`applySwap` need — taken AFTER `lockAccount`
   *  so the limit checks below can't validate against a snapshot a racing
   *  request then invalidates before either commits. */
  private async loadSwapContext(
    accountId: string,
    currentDeviceId: string,
    swap: ActiveStoreSwap,
    tx: DbExecutor,
  ): Promise<{
    allStores: StoreSummary[];
    limits: ReconciliationLimits;
    targetDevices: StoreDeviceRow[];
    currentDeviceStoreIds: string[];
  }> {
    const [allStores, maxStores, maxDevices, targetDevices, currentDeviceStores] =
      await Promise.all([
        this.stores.listAllStores(accountId, tx),
        this.entitlements.get(accountId, 'max_stores', tx),
        this.entitlements.get(accountId, 'max_devices_per_store', tx),
        this.devices.listStoreDevices(swap.activateStoreId, tx),
        this.devices.activeStoresForDevices([currentDeviceId], tx),
      ]);

    return {
      allStores,
      limits: { maxStores, maxDevices },
      targetDevices,
      currentDeviceStoreIds: currentDeviceStores.get(currentDeviceId) ?? [],
    };
  }

  /**
   * Server-side re-validation (never trust the client), mirroring `validate()`
   * for the resolve flow: the deactivate/activate stores must genuinely be in
   * the state the swap implies, every kept id must belong to the target
   * store, post-swap counts must still fit the plan's limits, and the
   * caller's own current device is never signed out with no way back in —
   * same self-lockout guard `validate()` applies to the resolve flow (BR-
   * DEV-005-equivalent): if the store about to be locked is the one the
   * caller's current device is active in, that device must be among the
   * newly-activated store's kept devices, or the caller loses all access.
   */
  private validateSwap(
    allStores: StoreSummary[],
    swap: ActiveStoreSwap,
    limits: ReconciliationLimits,
    targetDevices: StoreDeviceRow[],
    currentDeviceId: string,
    currentDeviceStoreIds: string[],
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

    const targetDeviceIds = new Set(targetDevices.map((d) => d.deviceFk));

    if (swap.keepDeviceIds.some((id) => !targetDeviceIds.has(id))) {
      throw new UnprocessableError(
        ErrorCodes.UNKNOWN_DEVICE,
        'One or more devices do not belong to the target store',
      );
    }

    if (limits.maxDevices !== null && swap.keepDeviceIds.length > limits.maxDevices) {
      throw new UnprocessableError(
        ErrorCodes.OVER_DEVICE_LIMIT,
        'Kept devices exceed the plan limit',
      );
    }

    // Self-lockout guard (BR-DEV-005-equivalent, mirrors `validate()`): the
    // caller's current device is active in the store this swap is about to
    // lock. It must be kept on the newly-activated store, or the caller
    // loses all access with no surface left to undo the swap from.
    if (
      currentDeviceStoreIds.includes(swap.deactivateStoreId) &&
      !swap.keepDeviceIds.includes(currentDeviceId)
    ) {
      throw new UnprocessableError(
        ErrorCodes.RECONCILIATION_INVALID,
        "You can't deactivate the store your current device is using unless your device stays on the newly-activated store — you'd be signed out with no way back in.",
      );
    }
  }

  /** The mutation phase — lock/unlock the swapped stores, restore/revoke the
   *  target store's device slots, and enqueue the outbox event. Assumes
   *  `validateSwap` already passed. */
  private async applySwap(
    accountId: string,
    userId: string,
    swap: ActiveStoreSwap,
    targetDevices: StoreDeviceRow[],
    tx: DbExecutor,
  ): Promise<void> {
    await this.stores.lockMany([swap.deactivateStoreId], accountId, tx);
    await this.stores.unlockOne(swap.activateStoreId, accountId, tx);

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
   * the owner's current device is never allowed to be dropped — that would
   * sign them out of the only surface they could use to fix it.
   */
  private validate(
    ctx: ReconciliationContext,
    selection: ReconciliationSelection,
  ): void {
    const storeIds = new Set(ctx.stores.map((s) => s.id));
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

    if (selection.keepDeviceIds.some((id) => !deviceIds.has(id))) {
      fieldErrors.keepDeviceIds = "One or more selected devices don't exist.";
    } else {
      // A kept device whose store isn't itself kept is silently permissive
      // otherwise — the store-lock loop in apply() only ever locks a whole
      // store, so a device left here would just be revoked along with the
      // rest of its (dropped) store, contradicting the caller's own
      // selection instead of erroring on it.
      const keepStores = new Set(selection.keepStoreIds);
      const deviceById = new Map(ctx.devices.map((d) => [d.id, d]));
      if (
        selection.keepDeviceIds.some((id) => {
          const device = deviceById.get(id);
          return device !== undefined && !keepStores.has(device.storeId);
        })
      ) {
        fieldErrors.keepDeviceIds =
          "One or more selected devices belong to a store you're not keeping.";
      }
    }

    if (!fieldErrors.keepStoreIds) {
      const keepStores = new Set(selection.keepStoreIds);
      for (const store of ctx.stores) {
        if (!keepStores.has(store.id)) continue;

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
      }
    }

    // Self-lockout guard (BR-DEV-005-equivalent), checked unconditionally
    // against every device — not just those in a kept store. Dropping the
    // owner's current device by excluding its WHOLE STORE is just as much a
    // lockout as excluding the device within a kept store; both must be
    // caught, or an owner using the app on the store they just deselected
    // signs themselves out with no guard firing (the bug this replaces).
    //
    // The current physical device can hold MULTIPLE entries here — one slot
    // per store it's currently active in (see ReconciliationDeviceInfo) — so
    // this must be an ANY check, not "the first entry found": the owner only
    // needs to remain reachable through at least one of those stores, not
    // every one of them. A `.find()`-based single-entry check here would
    // false-positive-block a valid selection whenever the current device's
    // FIRST listed slot happens to be in a store the owner is dropping, even
    // though a different kept store would have kept them fully reachable.
    const currentDeviceEntries = ctx.devices.filter((d) => d.isCurrentDevice);
    if (currentDeviceEntries.length > 0) {
      const staysReachable = currentDeviceEntries.some(
        (d) =>
          selection.keepStoreIds.includes(d.storeId) &&
          selection.keepDeviceIds.includes(d.id),
      );
      if (!staysReachable) {
        fieldErrors.keepDeviceIds =
          "You can't remove every store/device you're currently using — you'd be signed out with no way back in.";
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
}
