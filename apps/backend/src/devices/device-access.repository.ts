import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, lt, notInArray, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DRIZZLE, type DbExecutor } from '#db/db.module.js';
import { requireRow } from '#db/require-row.js';
import * as schema from '#db/schema.js';
import {
  storeDeviceAccess,
  devices,
  users,
  stores,
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

export interface StoreDeviceRowWithStore extends StoreDeviceRow {
  storeFk: string;
}

/** How a device slot was released — audited in `store_device_access.revoked_reason`. */
export type SlotRevokeReason =
  | 'owner_removed'
  | 'stolen'
  | 'auto_expired'
  | 'plan_downgrade'
  | 'released';

/** Shared column projection for the store-device list joins (slot + device +
 *  user), so the list variants can't drift column-by-column. */
const storeDeviceColumns = {
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
};

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
    data: { storeFk: string; deviceFk: string; userFk: string },
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
      .select(storeDeviceColumns)
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
      .select(storeDeviceColumns)
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
      .select({ ...storeDeviceColumns, storeFk: storeDeviceAccess.storeFk })
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
    reason: SlotRevokeReason,
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
    const client = this.client(tx);

    // One row per device — the most recently revoked plan_downgrade slot —
    // for devices that don't already hold a fresh active slot (see doc
    // comment above for why those are skipped). Picking exactly one row per
    // device via selectDistinctOn (ordered by revokedAt desc) matters just
    // like it does in restoreSlot: a device revoked more than once over time
    // leaves multiple historical 'revoked' rows for the same (store, device),
    // and flipping more than one to 'active' in the same statement would
    // collide with the uk_sda_active partial unique index.
    const targetIds = client
      .selectDistinctOn([storeDeviceAccess.deviceFk], { id: storeDeviceAccess.id })
      .from(storeDeviceAccess)
      .where(and(
        eq(storeDeviceAccess.storeFk, storeId),
        eq(storeDeviceAccess.status, 'revoked'),
        eq(storeDeviceAccess.revokedReason, 'plan_downgrade'),
        notInArray(
          storeDeviceAccess.deviceFk,
          client
            .select({ deviceFk: storeDeviceAccess.deviceFk })
            .from(storeDeviceAccess)
            .where(and(
              eq(storeDeviceAccess.storeFk, storeId),
              eq(storeDeviceAccess.status, 'active'),
            )),
        ),
      ))
      .orderBy(storeDeviceAccess.deviceFk, desc(storeDeviceAccess.revokedAt));

    await client
      .update(storeDeviceAccess)
      .set({ status: 'active', revokedAt: null, revokedBy: null, revokedReason: null, modifiedAt: new Date() })
      .where(and(
        inArray(storeDeviceAccess.id, targetIds),
        eq(storeDeviceAccess.status, 'revoked'),
      ));
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

    // Target the single most recent revoked row for this (store, device), not
    // every historical one: a device revoked more than once over time leaves
    // multiple 'revoked' rows for the same (store, device), and an UPDATE
    // matching all of them would flip more than one to 'active' in the same
    // statement, colliding with the uk_sda_active partial unique index (P1).
    const client = this.client(tx);
    const [mostRecent] = await client
      .select({ id: storeDeviceAccess.id })
      .from(storeDeviceAccess)
      .where(and(
        eq(storeDeviceAccess.storeFk, storeId),
        eq(storeDeviceAccess.deviceFk, deviceId),
        eq(storeDeviceAccess.status, 'revoked'),
      ))
      .orderBy(desc(storeDeviceAccess.revokedAt))
      .limit(1);
    if (!mostRecent) return;

    await client
      .update(storeDeviceAccess)
      .set({ status: 'active', revokedAt: null, revokedBy: null, revokedReason: null, modifiedAt: new Date() })
      .where(and(
        eq(storeDeviceAccess.id, mostRecent.id),
        eq(storeDeviceAccess.status, 'revoked'),
      ));
  }

  /** Revoke ALL of a device's slots across every store (block/F8, or a
   *  device-scoped logout releasing every store it was using). */
  async revokeAllSlotsForDevice(
    deviceId: string,
    revokedBy: string,
    reason: SlotRevokeReason,
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

  /**
   * Revoke one specific slot by its own id — the reconciliation resolve flow
   * works in slot ids directly (a device can hold active slots in more than
   * one store at once, so a bare device id can't unambiguously identify which
   * one to revoke; see ReconciliationService.getContext). Returns rows
   * affected (0 or 1).
   */
  async revokeSlotById(
    slotId: string,
    revokedBy: string,
    reason: SlotRevokeReason,
    tx?: DbExecutor,
  ): Promise<number> {
    const rows = await this.client(tx)
      .update(storeDeviceAccess)
      .set({ status: 'revoked', revokedAt: new Date(), revokedBy, revokedReason: reason, modifiedAt: new Date() })
      .where(and(
        eq(storeDeviceAccess.id, slotId),
        eq(storeDeviceAccess.status, 'active'),
      ))
      .returning({ id: storeDeviceAccess.id });
    return rows.length;
  }

  /**
   * Auto-expire slots idle past `staleBefore` (device-management: slots free
   * on owner-remove / block / 30-day expiry). `limit` bounds each call to one
   * batch — the cron loops until a batch comes back short of `limit`, so a
   * mass idle-expiry never runs as one unbounded UPDATE. The predicate is
   * repeated on the outer UPDATE (not just the inner id-selecting SELECT), same
   * as SubscriptionRepository.expireTrials, so a concurrent touchSlot() between
   * the inner snapshot and this UPDATE is re-validated by Postgres's
   * EvalPlanQual and skipped instead of blindly expiring a slot that was just
   * heartbeated.
   */
  async expireStaleSlots(staleBefore: Date, limit: number, tx?: DbExecutor): Promise<string[]> {
    const client = this.client(tx);
    const rows = await client
      .update(storeDeviceAccess)
      .set({
        status:         'expired',
        revokedAt:      new Date(),
        revokedReason:  'auto_expired',
        modifiedAt:     new Date(),
      })
      .where(and(
        inArray(
          storeDeviceAccess.id,
          client
            .select({ id: storeDeviceAccess.id })
            .from(storeDeviceAccess)
            .where(and(
              eq(storeDeviceAccess.status, 'active'),
              lt(storeDeviceAccess.lastAccessedAt, staleBefore),
            ))
            .limit(limit),
        ),
        eq(storeDeviceAccess.status, 'active'),
        lt(storeDeviceAccess.lastAccessedAt, staleBefore),
      ))
      .returning({ id: storeDeviceAccess.id });
    return rows.map((r) => r.id);
  }

  // ─── Device identity ────────────────────────────────────────────────────────
  // Ownership lookups, blocking, and session revocation for the `devices`/
  // `deviceSessions` aggregates live on their owning repositories —
  // `DeviceRepository` and `AuthSessionRepository` (auth/mobile) — not here,
  // so there's exactly one write path per table (layered-architecture §3.6).

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
