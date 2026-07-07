import { Inject, Injectable } from '@nestjs/common';
import { and, eq, exists, inArray, isNull } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DRIZZLE, type DbExecutor } from '#db/db.module.js';
import * as schema from '#db/schema.js';
import {
  userLocationMappings,
  locations,
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

  /**
   * True if the user holds an active role AT THIS STORE — not merely account
   * membership. Location assignment is the WHERE gate; it must not outrun
   * role assignment (the WHAT gate) within an account, or a user with a role
   * at Store A but none at Store B could be granted Store B location access.
   */
  async isStoreMember(userId: string, storeId: string, tx?: DbExecutor): Promise<boolean> {
    const [row] = await this.client(tx)
      .select({ id: userRoleMappings.id })
      .from(userRoleMappings)
      .where(and(
        eq(userRoleMappings.userFk, userId),
        eq(userRoleMappings.storeFk, storeId),
        isNull(userRoleMappings.revokedAt),
      ));
    return !!row;
  }

  /** Batched counterpart to `isStoreMember` — one query for every user in the
   *  set instead of N sequential per-user checks; returns the subset that ARE
   *  active store members. */
  async isStoreMemberBatch(userIds: string[], storeId: string, tx?: DbExecutor): Promise<Set<string>> {
    if (userIds.length === 0) return new Set();
    const rows = await this.client(tx)
      .selectDistinct({ userFk: userRoleMappings.userFk })
      .from(userRoleMappings)
      .where(and(
        inArray(userRoleMappings.userFk, userIds),
        eq(userRoleMappings.storeFk, storeId),
        isNull(userRoleMappings.revokedAt),
      ));
    return new Set(rows.map((r) => r.userFk));
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

  /** The many-users/one-location counterpart to `assignMany` — one insert for
   *  every granted user instead of N sequential per-user inserts (bulk
   *  location-user assignment, up to 50 users per call). */
  async assignManyUsers(userIds: string[], locationId: string, assignedBy: string, tx?: DbExecutor): Promise<void> {
    if (userIds.length === 0) return;
    await this.client(tx)
      .insert(userLocationMappings)
      .values(userIds.map((userFk) => ({ userFk, locationFk: locationId, assignedBy })))
      .onConflictDoUpdate({
        target: [userLocationMappings.userFk, userLocationMappings.locationFk],
        set: { revokedAt: null, assignedBy, assignedAt: new Date() },
      });
  }

  /**
   * Soft-revoke an assignment. Returns rows affected. `user_location_mappings`
   * has no store_fk column of its own (by schema design), so the store scope
   * is enforced via an EXISTS check against `locations` — the guarantee lives
   * in the query, not solely in the caller having pre-validated the location.
   */
  async revoke(userId: string, locationId: string, storeId: string, tx?: DbExecutor): Promise<number> {
    const client = this.client(tx);
    const rows = await client
      .update(userLocationMappings)
      .set({ revokedAt: new Date() })
      .where(and(
        eq(userLocationMappings.userFk, userId),
        eq(userLocationMappings.locationFk, locationId),
        isNull(userLocationMappings.revokedAt),
        exists(
          client
            .select({ id: locations.id })
            .from(locations)
            .where(and(eq(locations.id, locationId), eq(locations.storeFk, storeId))),
        ),
      ))
      .returning({ id: userLocationMappings.id });
    return rows.length;
  }

  /**
   * Users actively assigned to a location, scoped to the store it belongs to.
   * Defensive cap, not real pagination — see LocationRepository.listActive
   * for why (plain-array wire contract the mobile client renders in full);
   * `max_users_per_store` is unlimited on some plans, so this can't rely on
   * "the list is always small" the way roles/invitations can.
   */
  async listMembers(locationId: string, storeId: string, tx?: DbExecutor): Promise<LocationMember[]> {
    return this.client(tx)
      .select({
        userId:     users.id,
        userName:   users.name,
        assignedAt: userLocationMappings.assignedAt,
      })
      .from(userLocationMappings)
      .innerJoin(users, eq(userLocationMappings.userFk, users.id))
      .innerJoin(locations, eq(userLocationMappings.locationFk, locations.id))
      .where(and(
        eq(userLocationMappings.locationFk, locationId),
        eq(locations.storeFk, storeId),
        isNull(userLocationMappings.revokedAt),
      ))
      .limit(500);
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
