import { Injectable } from '@nestjs/common';
import type { DbExecutor } from '#db/db.module.js';
import { EntitlementService } from './entitlement.service.js';
import { StoreRepository } from '../stores/store/store.repository.js';
import { DeviceAccessRepository } from '../devices/device-access.repository.js';

function exceedsLimit(limit: number | null, current: number): boolean {
  return limit !== null && current > limit;
}

/**
 * Detects whether an account exceeds its plan's limits on any axis, right
 * after a plan change commits its new `plan_fk` (subscription §15D,
 * device-management §19). Read-only — never locks/revokes/unlocks anything
 * itself. Only reports true/false so the caller (SubscriptionService) can set
 * `reconciliation_status` accordingly; the actual choice of what to keep is
 * the owner's, made later via the resolve API.
 *
 * `max_stores` is account-level; `max_devices_per_store` is per-store, so
 * every active store must be checked individually — a downgrade can leave
 * the store *count* fine while one specific store is over on devices.
 *
 * `max_products` is deliberately NOT checked here: unlike stores/devices,
 * there is no product-selection step in ReconciliationService (no product
 * CRUD/management surface exists yet — products are sync-only). Including it
 * in this account-wide write-block would either freeze the account
 * permanently (no selection could satisfy it) or force a no-op store/device
 * selection to rubber-stamp `reconciliationStatus: 'applied'` while still
 * over the product limit. `max_products` should be enforced prospectively,
 * at product-creation time, once that surface exists — not retroactively
 * here.
 *
 * Callers MUST run this inside the same transaction they hold the account's
 * plan-change lock in. This method additionally takes the same `lockAccount`/
 * `lockStore` row locks that `createStore`/device-slot-claim
 * already take for their own limit rechecks (§per-store lock convention) —
 * without them, a concurrent create on any axis and this over-limit check are
 * two independent reads that can each pass before the other commits, letting
 * the account end up over its new plan's limit with nothing ever detecting it.
 */
@Injectable()
export class DowngradeDetectionService {
  constructor(
    private readonly entitlements: EntitlementService,
    private readonly stores: StoreRepository,
    private readonly devices: DeviceAccessRepository,
  ) {}

  async isOverLimit(accountId: string, tx: DbExecutor): Promise<boolean> {
    // Serializes against a concurrent createStore for this account (same
    // account-row lock createStore takes before its own max_stores recheck).
    await this.stores.lockAccount(accountId, tx);

    const [maxStores, maxDevices] =
      await Promise.all([
        this.entitlements.get(accountId, 'max_stores', tx),
        this.entitlements.get(accountId, 'max_devices_per_store', tx),
      ]);

    const activeStores = await this.stores.listActiveStores(accountId, tx);
    if (exceedsLimit(maxStores, activeStores.length)) return true;

    const storeIds = activeStores.map((s) => s.id);

    // Serializes against a concurrent claimSlot for each of these stores
    // (same per-store row lock claimSlot takes before its own
    // max_devices_per_store recheck) — without this, a concurrent slot claim
    // and this over-limit check are two independent reads that can each pass
    // before the other commits, letting the store end up over its new plan's
    // per-store device limit with nothing ever detecting it.
    for (const storeId of storeIds) {
      await this.devices.lockStore(storeId, tx);
    }

    const deviceCounts = await this.devices.countActiveSlotsByStores(storeIds, tx);

    for (const storeId of storeIds) {
      if (exceedsLimit(maxDevices, deviceCounts.get(storeId) ?? 0)) return true;
    }
    return false;
  }
}
