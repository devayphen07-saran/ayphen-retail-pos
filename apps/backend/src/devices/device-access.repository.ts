import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DRIZZLE, type DbExecutor } from '#db/db.module.js';
import * as schema from '#db/schema.js';
import {
  storeDeviceAccess,
  devices,
  deviceSessions,
  users,
} from '#db/schema.js';

export type StoreDeviceAccess = typeof storeDeviceAccess.$inferSelect;

export interface StoreDeviceRow {
  id:             string;
  deviceFk:       string;
  userFk:         string;
  status:         string;
  deviceLabel:    string | null;
  lastAccessedAt: Date;
  firstAccessedAt: Date;
  revokedAt:      Date | null;
  revokedReason:  string | null;
  model:          string | null;
  platform:       string;
  userName:       string;
}

/** Data access for the device↔store slot model (device-management §3.3, §7). */
@Injectable()
export class DeviceAccessRepository {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>,
  ) {}

  private client(tx?: DbExecutor) {
    return tx ?? this.db;
  }

  /** The active slot for (store, device), if any. */
  async findActiveSlot(
    storeId: string,
    deviceId: string,
    tx?: DbExecutor,
  ): Promise<StoreDeviceAccess | null> {
    const [row] = await this.client(tx)
      .select()
      .from(storeDeviceAccess)
      .where(and(
        eq(storeDeviceAccess.storeFk, storeId),
        eq(storeDeviceAccess.deviceFk, deviceId),
        eq(storeDeviceAccess.status, 'active'),
      ));
    return row ?? null;
  }

  /** Count active slots in a store (the max_devices_per_store denominator). */
  async countActiveSlots(storeId: string, tx?: DbExecutor): Promise<number> {
    const [row] = await this.client(tx)
      .select({ n: sql<number>`count(*)::int` })
      .from(storeDeviceAccess)
      .where(and(
        eq(storeDeviceAccess.storeFk, storeId),
        eq(storeDeviceAccess.status, 'active'),
      ));
    return row?.n ?? 0;
  }

  /** Touch an existing slot's heartbeat (F2 re-claim / BR-DEV-004). */
  async touchSlot(id: string, tx?: DbExecutor): Promise<void> {
    await this.client(tx)
      .update(storeDeviceAccess)
      .set({ lastAccessedAt: new Date(), modifiedAt: new Date() })
      .where(eq(storeDeviceAccess.id, id));
  }

  /**
   * Insert a new active slot. Relies on the partial unique index uk_sda_active
   * to reject a concurrent second insert for the same (store, device) — the
   * caller treats a unique violation as "already claimed" and re-reads.
   */
  async insertSlot(
    data: { storeFk: string; deviceFk: string; userFk: string; locationFk?: string | null },
    tx?: DbExecutor,
  ): Promise<StoreDeviceAccess> {
    const [row] = await this.client(tx)
      .insert(storeDeviceAccess)
      .values({ ...data, status: 'active' })
      .returning();
    return row!;
  }

  /** Store device list (active + recently revoked), joined with device + user. */
  async listStoreDevices(storeId: string, tx?: DbExecutor): Promise<StoreDeviceRow[]> {
    return this.client(tx)
      .select({
        id:              storeDeviceAccess.id,
        deviceFk:        storeDeviceAccess.deviceFk,
        userFk:          storeDeviceAccess.userFk,
        status:          storeDeviceAccess.status,
        deviceLabel:     storeDeviceAccess.deviceLabel,
        lastAccessedAt:  storeDeviceAccess.lastAccessedAt,
        firstAccessedAt: storeDeviceAccess.firstAccessedAt,
        revokedAt:       storeDeviceAccess.revokedAt,
        revokedReason:   storeDeviceAccess.revokedReason,
        model:           devices.model,
        platform:        devices.platform,
        userName:        users.name,
      })
      .from(storeDeviceAccess)
      .innerJoin(devices, eq(storeDeviceAccess.deviceFk, devices.id))
      .innerJoin(users, eq(storeDeviceAccess.userFk, users.id))
      .where(eq(storeDeviceAccess.storeFk, storeId))
      .orderBy(desc(storeDeviceAccess.lastAccessedAt));
  }

  /** Revoke a device's active slot in one store (F5). Returns rows affected. */
  async revokeSlot(
    storeId: string,
    deviceId: string,
    revokedBy: string,
    reason: 'owner_removed' | 'stolen' | 'auto_expired' | 'plan_downgrade' | 'released',
    tx?: DbExecutor,
  ): Promise<number> {
    const rows = await this.client(tx)
      .update(storeDeviceAccess)
      .set({ status: 'revoked', revokedAt: new Date(), revokedBy, revokedReason: reason, modifiedAt: new Date() })
      .where(and(
        eq(storeDeviceAccess.storeFk, storeId),
        eq(storeDeviceAccess.deviceFk, deviceId),
        eq(storeDeviceAccess.status, 'active'),
      ))
      .returning({ id: storeDeviceAccess.id });
    return rows.length;
  }

  /** Revoke ALL of a device's slots across every store (block, F8). */
  async revokeAllSlotsForDevice(
    deviceId: string,
    revokedBy: string,
    reason: 'stolen',
    tx?: DbExecutor,
  ): Promise<void> {
    await this.client(tx)
      .update(storeDeviceAccess)
      .set({ status: 'revoked', revokedAt: new Date(), revokedBy, revokedReason: reason, modifiedAt: new Date() })
      .where(and(
        eq(storeDeviceAccess.deviceFk, deviceId),
        eq(storeDeviceAccess.status, 'active'),
      ));
  }

  // ─── Device identity (owned by the user) ───────────────────────────────────

  /** A device owned by this user, or null (ownership guard for block/unblock). */
  async findOwnedDevice(
    deviceId: string,
    userId: string,
    tx?: DbExecutor,
  ): Promise<typeof devices.$inferSelect | null> {
    const [row] = await this.client(tx)
      .select()
      .from(devices)
      .where(and(eq(devices.id, deviceId), eq(devices.userFk, userId)));
    return row ?? null;
  }

  /** All devices registered to a user (My Devices, F7). */
  async listUserDevices(userId: string, tx?: DbExecutor) {
    return this.client(tx)
      .select()
      .from(devices)
      .where(eq(devices.userFk, userId))
      .orderBy(desc(devices.lastSeenAt));
  }

  async setBlocked(
    deviceId: string,
    blocked: boolean,
    tx?: DbExecutor,
  ): Promise<void> {
    await this.client(tx)
      .update(devices)
      .set({
        isBlocked: blocked,
        isTrusted: blocked ? false : undefined,       // block clears trust
        blockedAt: blocked ? new Date() : null,
        pushToken: blocked ? null : undefined,         // null push token on block (F8/BR-DEV-014)
      })
      .where(eq(devices.id, deviceId));
  }

  /** Revoke all active sessions for a device (block, F8). */
  async revokeDeviceSessions(deviceId: string, reason: string, tx?: DbExecutor): Promise<void> {
    await this.client(tx)
      .update(deviceSessions)
      .set({ revokedAt: new Date(), revokedReason: reason })
      .where(and(eq(deviceSessions.deviceFk, deviceId), sql`${deviceSessions.revokedAt} IS NULL`));
  }

  /** Stores where this device currently holds an active slot (for My Devices). */
  async activeStoresForDevice(deviceId: string, tx?: DbExecutor): Promise<string[]> {
    const rows = await this.client(tx)
      .select({ storeFk: storeDeviceAccess.storeFk })
      .from(storeDeviceAccess)
      .where(and(eq(storeDeviceAccess.deviceFk, deviceId), eq(storeDeviceAccess.status, 'active')));
    return rows.map((r) => r.storeFk);
  }

  /** Set a per-store device label (F4). */
  async setDeviceLabel(slotId: string, label: string, tx?: DbExecutor): Promise<void> {
    await this.client(tx)
      .update(storeDeviceAccess)
      .set({ deviceLabel: label, modifiedAt: new Date() })
      .where(eq(storeDeviceAccess.id, slotId));
  }

}
