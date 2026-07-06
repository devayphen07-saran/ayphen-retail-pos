import { Injectable } from '@nestjs/common';
import type { DbExecutor } from '#db/db.module.js';
import { EntitlementService } from './entitlement.service.js';
import { StoreRepository } from '../stores/store/store.repository.js';
import { LocationRepository } from '../locations/location.repository.js';
import { DeviceAccessRepository } from '../devices/device-access.repository.js';

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
 * `max_stores` is account-level; `max_locations_per_store` and
 * `max_devices_per_store` are per-store, so every active store must be
 * checked individually — a downgrade can leave the store *count* fine while
 * one specific store is over on locations or devices.
 */
@Injectable()
export class DowngradeDetectionService {
  constructor(
    private readonly entitlements: EntitlementService,
    private readonly stores: StoreRepository,
    private readonly locations: LocationRepository,
    private readonly devices: DeviceAccessRepository,
  ) {}

  async isOverLimit(accountId: string, tx: DbExecutor): Promise<boolean> {
    const [maxStores, maxLocations, maxDevices] = await Promise.all([
      this.entitlements.get(accountId, 'max_stores', tx),
      this.entitlements.get(accountId, 'max_locations_per_store', tx),
      this.entitlements.get(accountId, 'max_devices_per_store', tx),
    ]);

    const activeStores = await this.stores.listActiveStores(accountId, tx);
    if (isOverLimit(maxStores, activeStores.length)) return true;

    for (const store of activeStores) {
      const [locationCount, deviceCount] = await Promise.all([
        this.locations.countActive(store.id, tx),
        this.devices.countActiveSlots(store.id, tx),
      ]);
      if (isOverLimit(maxLocations, locationCount)) return true;
      if (isOverLimit(maxDevices, deviceCount)) return true;
    }
    return false;
  }
}
