import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DRIZZLE, type DbExecutor } from '#db/db.module.js';
import * as schema from '#db/schema.js';
import {
  userLocationMappings,
  locations,
  accountUsers,
  stores,
  userRoleMappings,
  roles,
  users,
} from '#db/schema.js';

export interface LocationMember {
  userId:     string;
  userName:   string;
  assignedAt: Date;
}

/** Data access for user↔location assignment (adoption §8.1). */
@Injectable()
export class UserLocationRepository {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>,
  ) {}

  private client(tx?: DbExecutor) {
    return tx ?? this.db;
  }

  /** True if the user is a member of the store's account. */
  async isStoreMember(userId: string, storeId: string, tx?: DbExecutor): Promise<boolean> {
    const [row] = await this.client(tx)
      .select({ id: accountUsers.id })
      .from(accountUsers)
      .innerJoin(stores, eq(stores.accountFk, accountUsers.accountFk))
      .where(and(eq(stores.id, storeId), eq(accountUsers.userFk, userId)));
    return !!row;
  }

  /** True if the user holds an active STORE_OWNER role in this store (owner bypass). */
  async isStoreOwner(userId: string, storeId: string, tx?: DbExecutor): Promise<boolean> {
    const [row] = await this.client(tx)
      .select({ id: userRoleMappings.id })
      .from(userRoleMappings)
      .innerJoin(roles, eq(userRoleMappings.roleFk, roles.id))
      .where(and(
        eq(userRoleMappings.userFk, userId),
        eq(userRoleMappings.storeFk, storeId),
        eq(roles.code, 'STORE_OWNER'),
        isNull(userRoleMappings.revokedAt),
      ));
    return !!row;
  }

  /** Active assignment exists for (user, location)? */
  async isAssigned(userId: string, locationId: string, tx?: DbExecutor): Promise<boolean> {
    const [row] = await this.client(tx)
      .select({ id: userLocationMappings.id })
      .from(userLocationMappings)
      .where(and(
        eq(userLocationMappings.userFk, userId),
        eq(userLocationMappings.locationFk, locationId),
        isNull(userLocationMappings.revokedAt),
      ));
    return !!row;
  }

  /** Insert (or reactivate) an assignment. Idempotent on (user, location). */
  async assign(userId: string, locationId: string, assignedBy: string, tx?: DbExecutor): Promise<void> {
    await this.assignMany(userId, [locationId], assignedBy, tx);
  }

  /** Batched `assign` — one insert for every granted location (e.g. invitation accept). */
  async assignMany(userId: string, locationIds: string[], assignedBy: string, tx?: DbExecutor): Promise<void> {
    if (locationIds.length === 0) return;
    await this.client(tx)
      .insert(userLocationMappings)
      .values(locationIds.map((locationFk) => ({ userFk: userId, locationFk, assignedBy })))
      .onConflictDoUpdate({
        target: [userLocationMappings.userFk, userLocationMappings.locationFk],
        set: { revokedAt: null, assignedBy, assignedAt: new Date() },
      });
  }

  /** Soft-revoke an assignment. Returns rows affected. */
  async revoke(userId: string, locationId: string, tx?: DbExecutor): Promise<number> {
    const rows = await this.client(tx)
      .update(userLocationMappings)
      .set({ revokedAt: new Date() })
      .where(and(
        eq(userLocationMappings.userFk, userId),
        eq(userLocationMappings.locationFk, locationId),
        isNull(userLocationMappings.revokedAt),
      ))
      .returning({ id: userLocationMappings.id });
    return rows.length;
  }

  /** Users actively assigned to a location. */
  async listMembers(locationId: string, tx?: DbExecutor): Promise<LocationMember[]> {
    return this.client(tx)
      .select({
        userId:     users.id,
        userName:   users.name,
        assignedAt: userLocationMappings.assignedAt,
      })
      .from(userLocationMappings)
      .innerJoin(users, eq(userLocationMappings.userFk, users.id))
      .where(and(
        eq(userLocationMappings.locationFk, locationId),
        isNull(userLocationMappings.revokedAt),
      ));
  }

  /** Active location ids this user is assigned to within a store. */
  async assignedLocationIds(userId: string, storeId: string, tx?: DbExecutor): Promise<string[]> {
    const rows = await this.client(tx)
      .select({ id: locations.id })
      .from(userLocationMappings)
      .innerJoin(locations, eq(userLocationMappings.locationFk, locations.id))
      .where(and(
        eq(userLocationMappings.userFk, userId),
        eq(locations.storeFk, storeId),
        eq(locations.isActive, true),
        isNull(userLocationMappings.revokedAt),
      ));
    return rows.map((r) => r.id);
  }
}
