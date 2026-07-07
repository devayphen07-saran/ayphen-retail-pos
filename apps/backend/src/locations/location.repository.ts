import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, ne, sql, isNull } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DRIZZLE, type DbExecutor } from '#db/db.module.js';
import { requireRow } from '#db/require-row.js';
import * as schema from '#db/schema.js';
import { locations, stores } from '#db/schema.js';

export type Location = typeof locations.$inferSelect;

// Raw insert/rename can violate uk_location_name (schema.ts) under a create/
// rename race — the repository just lets that PostgresError propagate
// unmodified (translating it to a business exception is the service's job,
// per layered-architecture.md §3.6: repositories never apply business rules).

/** Data access for store locations (adoption §8.2, rbac.md §26.1). */
@Injectable()
export class LocationRepository {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>,
  ) {}

  private client(tx?: DbExecutor) {
    return tx ?? this.db;
  }

  /**
   * Active locations in a store, ordered for display. Defensive cap, not real
   * pagination — the response is a plain array the mobile client renders in
   * full (a location picker), so switching to a cursor-paginated envelope is
   * a breaking wire-contract change that needs a coordinated client update.
   * `max_locations_per_store` is unlimited on some plans, so an unbounded
   * query here is a real (if currently unlikely) "bound everything" gap.
   */
  async listActive(storeId: string, tx?: DbExecutor): Promise<Location[]> {
    return this.client(tx)
      .select()
      .from(locations)
      .where(and(eq(locations.storeFk, storeId), eq(locations.isActive, true)))
      .orderBy(locations.displayOrder, locations.createdAt)
      .limit(500);
  }

  /** Batched counterpart to `listActive` — one query for every store in the
   *  set instead of N sequential per-store calls (each row still carries its
   *  own `storeFk` for the caller to group by). */
  async listActiveByStores(storeIds: string[], tx?: DbExecutor): Promise<Location[]> {
    if (storeIds.length === 0) return [];
    return this.client(tx)
      .select()
      .from(locations)
      .where(and(inArray(locations.storeFk, storeIds), eq(locations.isActive, true)))
      .orderBy(locations.displayOrder, locations.createdAt);
  }

  async findInStore(locationId: string, storeId: string, tx?: DbExecutor): Promise<Location | null> {
    const [row] = await this.client(tx)
      .select()
      .from(locations)
      .where(and(
        eq(locations.id, locationId),
        eq(locations.storeFk, storeId),
        eq(locations.isActive, true),
      ));
    return row ?? null;
  }

  /**
   * Lock the store row for the duration of the transaction (SELECT ... FOR
   * UPDATE). Serializes concurrent location-creation attempts against the
   * same store so the max_locations_per_store recheck below it can't race —
   * mirrors StoreRepository.lockAccount / InvitationRepository.lockStore (the
   * same check-then-insert gate on a plan entitlement, closed the same way).
   */
  async lockStore(storeId: string, tx: DbExecutor): Promise<void> {
    await tx
      .select({ id: stores.id })
      .from(stores)
      .where(eq(stores.id, storeId))
      .for('update');
  }

  /** Batched counterpart to `lockStore` — one round trip to lock every store
   *  in the set instead of N sequential single-row locks (downgrade-detection
   *  §perf: an account with many active stores was issuing N awaited
   *  `lockStore` calls in a loop). */
  async lockManyStores(storeIds: string[], tx: DbExecutor): Promise<void> {
    if (storeIds.length === 0) return;
    await tx
      .select({ id: stores.id })
      .from(stores)
      .where(inArray(stores.id, storeIds))
      .for('update');
  }

  /** Active-location count — the max_locations_per_store denominator. */
  async countActive(storeId: string, tx?: DbExecutor): Promise<number> {
    const [row] = await this.client(tx)
      .select({ n: sql<number>`count(*)::int` })
      .from(locations)
      .where(and(eq(locations.storeFk, storeId), eq(locations.isActive, true)));
    return row?.n ?? 0;
  }

  /** Batched counterpart to `countActive` — one grouped query for every store
   *  in the set instead of N sequential per-store counts. Stores with zero
   *  active locations are simply absent from the map (caller treats a missing
   *  key as 0). */
  async countActiveByStores(storeIds: string[], tx?: DbExecutor): Promise<Map<string, number>> {
    if (storeIds.length === 0) return new Map();
    const rows = await this.client(tx)
      .select({ storeFk: locations.storeFk, n: sql<number>`count(*)::int` })
      .from(locations)
      .where(and(inArray(locations.storeFk, storeIds), eq(locations.isActive, true)))
      .groupBy(locations.storeFk);
    return new Map(rows.map((r) => [r.storeFk, r.n]));
  }

  async nameTaken(storeId: string, name: string, excludeId?: string, tx?: DbExecutor): Promise<boolean> {
    const [row] = await this.client(tx)
      .select({ id: locations.id })
      .from(locations)
      .where(and(
        eq(locations.storeFk, storeId),
        eq(locations.isActive, true),
        sql`lower(${locations.name}) = lower(${name})`,
        excludeId ? ne(locations.id, excludeId) : undefined,
      ));
    return Boolean(row);
  }

  /** How many active defaults exist (for the "last default" guard). */
  async countDefaults(storeId: string, tx?: DbExecutor): Promise<number> {
    const [row] = await this.client(tx)
      .select({ n: sql<number>`count(*)::int` })
      .from(locations)
      .where(and(
        eq(locations.storeFk, storeId),
        eq(locations.isActive, true),
        eq(locations.isDefault, true),
      ));
    return row?.n ?? 0;
  }

  async insert(
    data: { storeFk: string; name: string; isDefault?: boolean; displayOrder?: number },
    tx?: DbExecutor,
  ): Promise<Location> {
    const [row] = await this.client(tx).insert(locations).values(data).returning();
    return requireRow(row);
  }

  async update(
    locationId: string,
    storeId: string,
    patch: Partial<Pick<Location, 'name' | 'enable' | 'isDefault' | 'displayOrder'>>,
    tx?: DbExecutor,
  ): Promise<void> {
    await this.client(tx)
      .update(locations)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(locations.id, locationId), eq(locations.storeFk, storeId)));
  }

  /** Clear the default flag on every OTHER active location in the store. */
  /** Clears every default in the store except `keepId` — or every default at
   *  all when `keepId` is omitted (the new-row-doesn't-exist-yet case). */
  async clearOtherDefaults(storeId: string, keepId?: string, tx?: DbExecutor): Promise<void> {
    await this.client(tx)
      .update(locations)
      .set({ isDefault: false, updatedAt: new Date() })
      .where(and(
        eq(locations.storeFk, storeId),
        eq(locations.isDefault, true),
        keepId ? ne(locations.id, keepId) : undefined,
      ));
  }

  /** Soft-delete (archive) a location. */
  async softDelete(locationId: string, storeId: string, tx?: DbExecutor): Promise<void> {
    await this.client(tx)
      .update(locations)
      .set({ isActive: false, archivedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(locations.id, locationId), eq(locations.storeFk, storeId)));
  }

  /** Lock locations as downgrade-excess (reconciliation §5.2). Head Office is
   *  never passed in here — it's immune, never a candidate for locking. */
  async lockMany(locationIds: string[], tx: DbExecutor): Promise<void> {
    if (locationIds.length === 0) return;
    await tx
      .update(locations)
      .set({ locked: true, lockedReason: 'downgrade', updatedAt: new Date() })
      .where(inArray(locations.id, locationIds));
  }

  /** Unlock specific locations — the reconciliation "swap active store"
   *  endpoint's targeted counterpart to `unlockDowngraded`'s per-store bulk restore. */
  async unlockMany(locationIds: string[], tx: DbExecutor): Promise<void> {
    if (locationIds.length === 0) return;
    await tx
      .update(locations)
      .set({ locked: false, lockedReason: null, updatedAt: new Date() })
      .where(inArray(locations.id, locationIds));
  }

  /** Re-upgrade mirror (reconciliation §9) — unlock every location in this
   *  store that was locked for a downgrade. */
  async unlockDowngraded(storeId: string, tx: DbExecutor): Promise<void> {
    await tx
      .update(locations)
      .set({ locked: false, lockedReason: null, updatedAt: new Date() })
      .where(and(eq(locations.storeFk, storeId), eq(locations.lockedReason, 'downgrade')));
  }

  /** Locations a user is assigned to in a store (owner path passes all). */
  async listAssignedIds(userId: string, storeId: string, tx?: DbExecutor): Promise<string[]> {
    const rows = await this.client(tx)
      .select({ id: schema.locations.id })
      .from(schema.userLocationMappings)
      .innerJoin(schema.locations, eq(schema.userLocationMappings.locationFk, schema.locations.id))
      .where(and(
        eq(schema.userLocationMappings.userFk, userId),
        eq(schema.locations.storeFk, storeId),
        eq(schema.locations.isActive, true),
        isNull(schema.userLocationMappings.revokedAt),
      ));
    return rows.map((r) => r.id);
  }
}
