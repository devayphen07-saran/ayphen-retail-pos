import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import postgres from 'postgres';
import { UnitOfWork } from '#db/db.module.js';
import { EntitlementService } from '../subscription/entitlement.service.js';
import { AuditService } from '#auth/core/audit.service.js';
import { DeviceAccessRepository, type StoreDeviceRow } from './device-access.repository.js';

export interface SlotClaimResult {
  access: 'granted';
  isNew:  boolean;
}

export interface MyDevice {
  id:        string;
  model:     string | null;
  platform:  string;
  osVersion: string | null;
  appVersion: string | null;
  isTrusted: boolean;
  isBlocked: boolean;
  lastSeenAt: Date;
  storeIds:  string[];
}

/**
 * Device slot lifecycle (device-management §7 F2, §10 F5, §13 F8, §14 F9, §12 F7).
 * The slot claim is atomic: the count check + insert run in a transaction, and
 * the partial unique index uk_sda_active is the concurrency backstop so two
 * devices can never share the last slot (BR-DEV-018).
 */
@Injectable()
export class DeviceAccessService {
  constructor(
    private readonly repo: DeviceAccessRepository,
    private readonly entitlements: EntitlementService,
    private readonly audit: AuditService,
    private readonly uow: UnitOfWork,
  ) {}

  /**
   * Claim (or refresh) this device's slot in a store. `accountId` resolves the
   * plan's max_devices_per_store. Returns granted or throws DEVICE_LIMIT_REACHED.
   */
  async claimSlot(
    storeId: string,
    accountId: string,
    deviceId: string,
    userId: string,
  ): Promise<SlotClaimResult> {
    // Already have an active slot → just heartbeat (idempotent re-claim, F2).
    const existing = await this.repo.findActiveSlot(storeId, deviceId);
    if (existing) {
      await this.repo.touchSlot(existing.id);
      return { access: 'granted', isNew: false };
    }

    const limit = await this.entitlements.get(accountId, 'max_devices_per_store');

    try {
      return await this.uow.execute(async (tx) => {
        // Recount inside the txn; null limit = unlimited (Enterprise).
        const active = await this.repo.countActiveSlots(storeId, tx);
        if (!this.entitlements.canCreate(limit, active)) {
          throw new ForbiddenException('DEVICE_LIMIT_REACHED');
        }
        await this.repo.insertSlot({ storeFk: storeId, deviceFk: deviceId, userFk: userId }, tx);
        return { access: 'granted' as const, isNew: true };
      });
    } catch (err) {
      // Lost the race for the last slot: another request inserted the same
      // (store, device) active row. Treat as a successful idempotent re-claim.
      if (err instanceof postgres.PostgresError && err.code === '23505') {
        return { access: 'granted', isNew: false };
      }
      throw err;
    }
  }

  /** Owner removes a device from a store (F5). Cannot remove your own current device. */
  async removeDevice(
    storeId: string,
    actorId: string,
    currentDeviceId: string,
    targetDeviceId: string,
  ): Promise<void> {
    if (targetDeviceId === currentDeviceId) {
      throw new ForbiddenException('CANNOT_REMOVE_CURRENT_DEVICE'); // self-lockout, BR-DEV-005
    }
    const revoked = await this.uow.execute(async (tx) => {
      const n = await this.repo.revokeSlot(storeId, targetDeviceId, actorId, 'owner_removed', tx);
      if (n > 0) await this.repo.revokeDeviceSessions(targetDeviceId, 'store_device_removed', tx);
      return n;
    });
    if (!revoked) throw new NotFoundException('DEVICE_SLOT_NOT_FOUND');

    await this.audit.log({
      event: 'DEVICE_REMOVED', activityType: 'DEVICE_BLOCKED',
      prefix: 'Device', suffix: 'removed from store',
      userId: actorId, storeFk: storeId, isSuccess: true,
      entityType: 'Device', entityId: targetDeviceId,
    });
  }

  async listStoreDevices(storeId: string): Promise<StoreDeviceRow[]> {
    return this.repo.listStoreDevices(storeId);
  }

  /** Block a stolen/lost device — global kill across all stores (F8). Owner of the device only. */
  async blockDevice(userId: string, targetDeviceId: string): Promise<void> {
    const device = await this.repo.findOwnedDevice(targetDeviceId, userId);
    if (!device) throw new NotFoundException('DEVICE_NOT_FOUND');

    await this.uow.execute(async (tx) => {
      await this.repo.setBlocked(targetDeviceId, true, tx);
      await this.repo.revokeDeviceSessions(targetDeviceId, 'device_blocked_stolen', tx);
      await this.repo.revokeAllSlotsForDevice(targetDeviceId, userId, 'stolen', tx);
    });

    await this.audit.log({
      event: 'DEVICE_BLOCKED', activityType: 'DEVICE_BLOCKED',
      prefix: 'Device', suffix: 'blocked (stolen/lost)',
      userId, isSuccess: true, entityType: 'Device', entityId: targetDeviceId,
    });
  }

  /** Unblock a recovered device (F9). Slots/sessions stay revoked — device is "fresh". */
  async unblockDevice(userId: string, targetDeviceId: string): Promise<void> {
    const device = await this.repo.findOwnedDevice(targetDeviceId, userId);
    if (!device) throw new NotFoundException('DEVICE_NOT_FOUND');
    await this.repo.setBlocked(targetDeviceId, false);
    await this.audit.log({
      event: 'DEVICE_UNBLOCKED', activityType: 'DEVICE_BLOCKED',
      prefix: 'Device', suffix: 'unblocked',
      userId, isSuccess: true, entityType: 'Device', entityId: targetDeviceId,
    });
  }

  /** My Devices — all devices for the user, with the stores each currently accesses (F7). */
  async listMyDevices(userId: string): Promise<MyDevice[]> {
    const devices = await this.repo.listUserDevices(userId);
    return Promise.all(
      devices.map(async (d) => ({
        id:         d.id,
        model:      d.model,
        platform:   d.platform,
        osVersion:  d.osVersion,
        appVersion: d.appVersion,
        isTrusted:  d.isTrusted,
        isBlocked:  d.isBlocked,
        lastSeenAt: d.lastSeenAt,
        storeIds:   await this.repo.activeStoresForDevice(d.id),
      })),
    );
  }
}
