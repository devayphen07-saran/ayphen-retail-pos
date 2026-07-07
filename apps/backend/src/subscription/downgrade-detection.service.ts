import { Injectable } from '@nestjs/common';
import type { DbExecutor } from '#db/db.module.js';
import { EntitlementService } from './entitlement.service.js';
import { ProductCountRepository } from './product-count.repository.js';
import { StoreRepository } from '../stores/store/store.repository.js';
import { LocationRepository } from '../locations/location.repository.js';
import { DeviceAccessRepository } from '../devices/device-access.repository.js';
import { InvitationRepository } from '../stores/invitation/invitation.repository.js';

function isOverLimit(limit: number | null, current: number): boolean {
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
 * `max_stores` is account-level; `max_locations_per_store`, `max_devices_per_store`,
 * `max_users_per_store`, and `max_products` are all per-store, so every active
 * store must be checked individually — a downgrade can leave the store *count*
 * fine while one specific store is over on any of the other four axes.
 *
 * Callers MUST run this inside the same transaction they hold the account's
 * plan-change lock in. This method additionally takes the same `lockAccount`/
 * `lockStore` row locks that `createStore`/`createLocation`/device-slot-claim
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
    private readonly locations: LocationRepository,
    private readonly devices: DeviceAccessRepository,
    private readonly invitations: InvitationRepository,
    private readonly products: ProductCountRepository,
  ) {}

  async isOverLimit(accountId: string, tx: DbExecutor): Promise<boolean> {
    // Serializes against a concurrent createStore for this account (same
    // account-row lock createStore takes before its own max_stores recheck).
    await this.stores.lockAccount(accountId, tx);

    const [maxStores, maxLocations, maxDevices, maxUsers, maxProducts] =
      await Promise.all([
        this.entitlements.get(accountId, 'max_stores', tx),
        this.entitlements.get(accountId, 'max_locations_per_store', tx),
        this.entitlements.get(accountId, 'max_devices_per_store', tx),
        this.entitlements.get(accountId, 'max_users_per_store', tx),
        this.entitlements.get(accountId, 'max_products', tx),
      ]);

    const activeStores = await this.stores.listActiveStores(accountId, tx);
    if (isOverLimit(maxStores, activeStores.length)) return true;

    const storeIds = activeStores.map((s) => s.id);

    // Batched: one round trip to lock every active store (instead of N
    // sequential single-row locks) — serializes against a concurrent
    // createLocation / device-slot-claim / invitation-create for any of
    // these stores, all of which lock the same stores row (by id) before
    // their own per-store recheck, so it doesn't matter which repository's
    // lock call we use here.
    await this.locations.lockManyStores(storeIds, tx);

    const [locationCounts, deviceCounts, userCounts, productCounts] =
      await Promise.all([
        this.locations.countActiveByStores(storeIds, tx),
        this.devices.countActiveSlotsByStores(storeIds, tx),
        this.invitations.countActiveStaffByStores(storeIds, tx),
        this.products.countActiveByStores(storeIds, tx),
      ]);

    for (const storeId of storeIds) {
      if (isOverLimit(maxLocations, locationCounts.get(storeId) ?? 0))
        return true;
      if (isOverLimit(maxDevices, deviceCounts.get(storeId) ?? 0)) return true;
      if (isOverLimit(maxUsers, userCounts.get(storeId) ?? 0)) return true;
      if (isOverLimit(maxProducts, productCounts.get(storeId) ?? 0))
        return true;
    }
    return false;
  }
}
