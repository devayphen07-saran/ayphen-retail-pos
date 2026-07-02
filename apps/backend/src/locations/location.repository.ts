import { Inject, Injectable } from '@nestjs/common';
import { and, eq, ne, sql, isNull } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DRIZZLE, type DbExecutor } from '../db/db.module.js';
import * as schema from '../db/schema.js';
import { locations } from '../db/schema.js';

export type Location = typeof locations.$inferSelect;

/** Data access for store locations (adoption §8.2, rbac.md §26.1). */
@Injectable()
export class LocationRepository {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>,
  ) {}

  private client(tx?: DbExecutor) {
    return tx ?? this.db;
  }

  /** Active locations in a store, ordered for display. */
  async listActive(storeId: string, tx?: DbExecutor): Promise<Location[]> {
    return this.client(tx)
      .select()
      .from(locations)
      .where(and(eq(locations.storeFk, storeId), eq(locations.isActive, true)))
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

  /** Active-location count — the max_locations_per_store denominator. */
  async countActive(storeId: string, tx?: DbExecutor): Promise<number> {
    const [row] = await this.client(tx)
      .select({ n: sql<number>`count(*)::int` })
      .from(locations)
      .where(and(eq(locations.storeFk, storeId), eq(locations.isActive, true)));
    return row?.n ?? 0;
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
    return row!;
  }

  async update(
    locationId: string,
    patch: Partial<Pick<Location, 'name' | 'enable' | 'isDefault' | 'displayOrder'>>,
    tx?: DbExecutor,
  ): Promise<void> {
    await this.client(tx)
      .update(locations)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(locations.id, locationId));
  }

  /** Clear the default flag on every OTHER active location in the store. */
  async clearOtherDefaults(storeId: string, keepId: string, tx?: DbExecutor): Promise<void> {
    await this.client(tx)
      .update(locations)
      .set({ isDefault: false, updatedAt: new Date() })
      .where(and(
        eq(locations.storeFk, storeId),
        eq(locations.isDefault, true),
        ne(locations.id, keepId),
      ));
  }

  /** Soft-delete (archive) a location. */
  async softDelete(locationId: string, tx?: DbExecutor): Promise<void> {
    await this.client(tx)
      .update(locations)
      .set({ isActive: false, archivedAt: new Date(), updatedAt: new Date() })
      .where(eq(locations.id, locationId));
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
