import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DRIZZLE, type DbExecutor } from '#db/db.module.js';
import { requireRow } from '#db/require-row.js';
import * as schema from '#db/schema.js';
import {
  storeDeviceAccess,
  devices,
  deviceSessions,
  users,
  stores,
} from '#db/schema.js';

export type StoreDeviceAccess = typeof storeDeviceAccess.$inferSelect;
export type DeviceRow = typeof devices.$inferSelect;

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

export interface StoreDeviceRowWithStore extends StoreDeviceRow {
  storeFk: string;
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

  /**
   * Lock the store row for the duration of the transaction (SELECT ... FOR
   * UPDATE). Serializes concurrent slot-claim attempts against the same store
   * so the max_devices_per_store recount below it can't race — mirrors
   * `StoreRepository.lockAccount` / `InvitationRepository.lockStore` (the same
   * check-then-insert gate on a plan entitlement, closed the same way).
   */
  async lockStore(storeId: string, tx: DbExecutor): Promise<void> {
    await tx
      .select({ id: stores.id })
      .from(stores)
      .where(eq(stores.id, storeId))
      .for('update');
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

  /** Batched counterpart to `countActiveSlots` — one grouped query for every
   *  store in the set instead of N sequential per-store counts. */
  async countActiveSlotsByStores(storeIds: string[], tx?: DbExecutor): Promise<Map<string, number>> {
    if (storeIds.length === 0) return new Map();
    const rows = await this.client(tx)
      .select({ storeFk: storeDeviceAccess.storeFk, n: sql<number>`count(*)::int` })
      .from(storeDeviceAccess)
      .where(and(
        inArray(storeDeviceAccess.storeFk, storeIds),
        eq(storeDeviceAccess.status, 'active'),
      ))
      .groupBy(storeDeviceAccess.storeFk);
    return new Map(rows.map((r) => [r.storeFk, r.n]));
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
    return requireRow(row);
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

  /** Active-only variant of `listStoreDevices` — filters in SQL rather than
   *  fetching every historical (incl. revoked) row and filtering in JS. Used
   *  by `claimSlot`'s over-limit path, which runs this while holding
   *  `lockStore`'s row lock — the SQL filter keeps that query bounded to the
   *  (plan-capped) active slot count instead of the store's full device
   *  history, which only ever grows. */
  async listActiveStoreDevices(storeId: string, tx?: DbExecutor): Promise<StoreDeviceRow[]> {
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
      .where(and(eq(storeDeviceAccess.storeFk, storeId), eq(storeDeviceAccess.status, 'active')))
      .orderBy(desc(storeDeviceAccess.lastAccessedAt));
  }

  /** Batched counterpart to `listStoreDevices` — one query for every store in
   *  the set instead of N sequential per-store calls (each row carries its
   *  own `storeFk` for the caller to group by). */
  async listStoreDevicesByStores(storeIds: string[], tx?: DbExecutor): Promise<StoreDeviceRowWithStore[]> {
    if (storeIds.length === 0) return [];
    return this.client(tx)
      .select({
        id:              storeDeviceAccess.id,
        storeFk:         storeDeviceAccess.storeFk,
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
      .where(inArray(storeDeviceAccess.storeFk, storeIds))
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

  /**
   * Re-upgrade mirror (reconciliation §9) — re-activate every slot in this
   * store that was revoked for a downgrade. Skips a slot whose device already
   * claimed a *fresh* active row in the meantime (e.g. it re-opened the store
   * after being revoked and there was room) — restoring the old row too would
   * either violate uk_sda_active or resurrect a stale duplicate; that device
   * has already moved on, so its old revoked row just stays revoked/historical.
   */
  async restoreDowngradedSlots(storeId: string, tx?: DbExecutor): Promise<void> {
    const revoked = await this.client(tx)
      .select({ id: storeDeviceAccess.id, deviceFk: storeDeviceAccess.deviceFk })
      .from(storeDeviceAccess)
      .where(and(
        eq(storeDeviceAccess.storeFk, storeId),
        eq(storeDeviceAccess.status, 'revoked'),
        eq(storeDeviceAccess.revokedReason, 'plan_downgrade'),
      ));

    for (const row of revoked) {
      await this.restoreSlot(storeId, row.deviceFk, tx);
    }
  }

  /**
   * Re-activate one specific device's revoked slot in a store — the
   * reconciliation "swap active store" endpoint's targeted counterpart to
   * `restoreDowngradedSlots`'s per-store bulk restore. No-ops if the device
   * already holds a fresh active slot (see `restoreDowngradedSlots` for why).
   */
  async restoreSlot(storeId: string, deviceId: string, tx?: DbExecutor): Promise<void> {
    const stillClaimed = await this.findActiveSlot(storeId, deviceId, tx);
    if (stillClaimed) return;
    await this.client(tx)
      .update(storeDeviceAccess)
      .set({ status: 'active', revokedAt: null, revokedBy: null, revokedReason: null, modifiedAt: new Date() })
      .where(and(
        eq(storeDeviceAccess.storeFk, storeId),
        eq(storeDeviceAccess.deviceFk, deviceId),
      ));
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
  async listUserDevices(userId: string, tx?: DbExecutor): Promise<DeviceRow[]> {
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

  /**
   * Revoke all active sessions for a device (block, F8; owner removal, F5).
   * Returns each revoked session's current access-JWT identity so the caller
   * can blacklist it — revoking the DB row alone doesn't invalidate a token
   * that's still unexpired and cached in MobileJwtGuard's session cache.
   */
  async revokeDeviceSessions(
    deviceId: string,
    reason: string,
    tx?: DbExecutor,
  ): Promise<{ id: string; currentJti: string | null; currentJtiExp: Date | null }[]> {
    return this.client(tx)
      .update(deviceSessions)
      .set({ revokedAt: new Date(), revokedReason: reason })
      .where(and(eq(deviceSessions.deviceFk, deviceId), sql`${deviceSessions.revokedAt} IS NULL`))
      .returning({
        id: deviceSessions.id,
        currentJti: deviceSessions.currentJti,
        currentJtiExp: deviceSessions.currentJtiExp,
      });
  }

  /** Stores where each of these devices currently holds an active slot (for
   *  My Devices) — one query grouped by device instead of one per device. */
  async activeStoresForDevices(
    deviceIds: string[],
    tx?: DbExecutor,
  ): Promise<Map<string, string[]>> {
    const result = new Map<string, string[]>();
    if (deviceIds.length === 0) return result;

    const rows = await this.client(tx)
      .select({ deviceFk: storeDeviceAccess.deviceFk, storeFk: storeDeviceAccess.storeFk })
      .from(storeDeviceAccess)
      .where(and(inArray(storeDeviceAccess.deviceFk, deviceIds), eq(storeDeviceAccess.status, 'active')));

    for (const row of rows) {
      const existing = result.get(row.deviceFk);
      if (existing) existing.push(row.storeFk);
      else result.set(row.deviceFk, [row.storeFk]);
    }
    return result;
  }

}
