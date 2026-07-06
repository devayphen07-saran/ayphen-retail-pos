import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DRIZZLE, type DbExecutor } from '#db/db.module.js';
import { requireRow } from '#db/require-row.js';
import * as schema from '#db/schema.js';
import {
  invitations,
  invitationLocations,
  userRoleMappings,
  userLocationMappings,
  accountUsers,
  locations,
  stores,
  roles,
  users,
} from '#db/schema.js';

export interface InvitationRow {
  id:       string;
  storeFk:  string;
  roleFk:   string;
  status:   string;
  expiresAt: Date;
}

/** InvitationRow plus the addressed contact — used to authorize id-based accept. */
export interface InvitationContactRow extends InvitationRow {
  phone: string | null;
  email: string | null;
}

export interface PendingInvitationRow {
  id:        string;
  storeId:   string;
  storeName: string;
  roleName:  string;
  expiresAt: Date;
}

@Injectable()
export class InvitationRepository {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>,
  ) {}

  private client(tx?: DbExecutor) {
    return tx ?? this.db;
  }

  /**
   * Distinct users with an active role assignment in this store — the
   * denominator of the max_users_per_store gate (subscription §10).
   */
  async countActiveStaff(storeId: string, tx?: DbExecutor): Promise<number> {
    const [row] = await this.client(tx)
      .select({ n: sql<number>`count(distinct ${userRoleMappings.userFk})::int` })
      .from(userRoleMappings)
      .where(
        and(eq(userRoleMappings.storeFk, storeId), isNull(userRoleMappings.revokedAt)),
      );
    return row?.n ?? 0;
  }

  /**
   * Lock the store row for the duration of the transaction (SELECT ... FOR
   * UPDATE). Serializes concurrent invitation-creation attempts against the
   * same store so the max_users_per_store recheck below it can't race.
   */
  async lockStore(storeId: string, tx: DbExecutor): Promise<void> {
    await tx
      .select({ id: stores.id })
      .from(stores)
      .where(eq(stores.id, storeId))
      .for('update');
  }

  async create(
    data: typeof invitations.$inferInsert,
    tx?: DbExecutor,
  ): Promise<{ id: string; token: string }> {
    const [row] = await this.client(tx)
      .insert(invitations)
      .values(data)
      .returning({ id: invitations.id, token: invitations.token });
    return requireRow(row);
  }

  /**
   * Of the given ids, the subset that are active locations of this store. The
   * caller compares length to reject unknown/foreign location ids (a client
   * can't scope an invite to a location outside the store it's inviting into).
   */
  async filterStoreLocationIds(
    storeId: string,
    ids: string[],
    tx?: DbExecutor,
  ): Promise<string[]> {
    if (ids.length === 0) return [];
    const rows = await this.client(tx)
      .select({ id: locations.id })
      .from(locations)
      .where(and(
        eq(locations.storeFk, storeId),
        eq(locations.isActive, true),
        inArray(locations.id, ids),
      ));
    return rows.map((r) => r.id);
  }

  /** Record which locations an invitation grants (the "WHERE" gate applied on accept). */
  async insertInvitationLocations(
    invitationId: string,
    locationIds: string[],
    tx?: DbExecutor,
  ): Promise<void> {
    if (locationIds.length === 0) return;
    await this.client(tx)
      .insert(invitationLocations)
      .values(locationIds.map((locationFk) => ({ invitationFk: invitationId, locationFk })))
      .onConflictDoNothing();
  }

  /** The location ids an invitation grants — read at accept time to assign the invitee. */
  async listInvitationLocationIds(invitationId: string, tx?: DbExecutor): Promise<string[]> {
    const rows = await this.client(tx)
      .select({ locationFk: invitationLocations.locationFk })
      .from(invitationLocations)
      .where(eq(invitationLocations.invitationFk, invitationId));
    return rows.map((r) => r.locationFk).filter((id): id is string => id !== null);
  }

  /**
   * Assign the invitee to each granted location (idempotent, reactivates a
   * soft-revoked row). Written here — alongside this repo's existing direct
   * writes to userRoleMappings/accountUsers — rather than importing the
   * locations module, to keep the accept transaction in one repository.
   */
  async assignLocations(
    userId: string,
    locationIds: string[],
    assignedBy: string,
    tx?: DbExecutor,
  ): Promise<void> {
    if (locationIds.length === 0) return;
    await this.client(tx)
      .insert(userLocationMappings)
      .values(locationIds.map((locationFk) => ({ userFk: userId, locationFk, assignedBy })))
      .onConflictDoUpdate({
        target: [userLocationMappings.userFk, userLocationMappings.locationFk],
        set: { revokedAt: null, assignedBy, assignedAt: new Date() },
      });
  }

  /** A pending invite already outstanding for this contact + role in this store. */
  async findPendingInvite(
    storeId: string,
    roleId: string,
    phone: string | undefined,
    email: string | undefined,
    tx?: DbExecutor,
  ): Promise<boolean> {
    const contactMatch = [];
    if (phone) contactMatch.push(eq(invitations.phone, phone));
    if (email) contactMatch.push(eq(invitations.email, email));
    if (contactMatch.length === 0) return false;

    const [row] = await this.client(tx)
      .select({ id: invitations.id })
      .from(invitations)
      .where(and(
        eq(invitations.storeFk, storeId),
        eq(invitations.roleFk, roleId),
        eq(invitations.status, 'pending'),
        gt(invitations.expiresAt, new Date()),
        or(...contactMatch),
      ));
    return Boolean(row);
  }

  async findByToken(token: string, tx?: DbExecutor): Promise<InvitationRow | null> {
    const [row] = await this.client(tx)
      .select({
        id: invitations.id,
        storeFk: invitations.storeFk,
        roleFk: invitations.roleFk,
        status: invitations.status,
        expiresAt: invitations.expiresAt,
      })
      .from(invitations)
      .where(eq(invitations.token, token));
    return row ?? null;
  }

  /**
   * Load an invitation by id together with the contact it was addressed to. Used
   * by the id-based in-app accept path, where the token isn't echoed by the
   * client — authorization is instead "this invite is addressed to the caller's
   * own verified phone/email" (checked in the service).
   */
  async findByIdForContact(
    invitationId: string,
    tx?: DbExecutor,
  ): Promise<InvitationContactRow | null> {
    const [row] = await this.client(tx)
      .select({
        id: invitations.id,
        storeFk: invitations.storeFk,
        roleFk: invitations.roleFk,
        status: invitations.status,
        expiresAt: invitations.expiresAt,
        phone: invitations.phone,
        email: invitations.email,
      })
      .from(invitations)
      .where(eq(invitations.id, invitationId));
    return row ?? null;
  }

  /**
   * Conditional on status='pending' — the CAS that actually decides accept
   * vs. reject when both race the same token. Returns false if the
   * invitation was no longer pending (already accepted/revoked by the other
   * side of the race, or a retried call), so the caller can raise a real
   * conflict instead of silently overwriting whatever the other path did.
   */
  async markAccepted(
    invitationId: string,
    userId: string,
    tx?: DbExecutor,
  ): Promise<boolean> {
    const rows = await this.client(tx)
      .update(invitations)
      .set({ status: 'accepted', acceptedBy: userId, acceptedAt: new Date() })
      .where(and(eq(invitations.id, invitationId), eq(invitations.status, 'pending')))
      .returning({ id: invitations.id });
    return rows.length > 0;
  }

  /** Invitee declines — same terminal state as a store revoking it. Same
   *  status='pending' CAS as markAccepted, for the same reason. */
  async markRevoked(invitationId: string, tx?: DbExecutor): Promise<boolean> {
    const rows = await this.client(tx)
      .update(invitations)
      .set({ status: 'revoked' })
      .where(and(eq(invitations.id, invitationId), eq(invitations.status, 'pending')))
      .returning({ id: invitations.id });
    return rows.length > 0;
  }

  /** Ensure the user is a member of the store's account (idempotent). */
  async ensureAccountMembership(
    userId: string,
    storeId: string,
    tx?: DbExecutor,
  ): Promise<void> {
    const [store] = await this.client(tx)
      .select({ accountFk: stores.accountFk })
      .from(stores)
      .where(eq(stores.id, storeId));
    if (!store) return;
    await this.client(tx)
      .insert(accountUsers)
      .values({ accountFk: store.accountFk, userFk: userId })
      .onConflictDoNothing();
  }

  async assignRole(
    userId: string,
    roleId: string,
    storeId: string,
    invitedBy: string,
    tx?: DbExecutor,
  ): Promise<void> {
    await this.client(tx)
      .insert(userRoleMappings)
      .values({ userFk: userId, roleFk: roleId, storeFk: storeId, assignedBy: invitedBy })
      .onConflictDoNothing();
  }

  /**
   * Pending, unexpired invitations addressed to this contact. Invitations
   * aren't keyed by userFk (the invitee may not have an account yet at invite
   * time) — matched by phone/email instead, same as `accept()` doesn't need
   * to since the token alone carries identity there.
   */
  async listPendingForContact(
    phone: string | null,
    email: string | null,
  ): Promise<PendingInvitationRow[]> {
    if (!phone && !email) return [];

    const contactMatch = [];
    if (phone) contactMatch.push(eq(invitations.phone, phone));
    if (email) contactMatch.push(eq(invitations.email, email));

    const rows = await this.db
      .select({
        id:        invitations.id,
        storeId:   invitations.storeFk,
        storeName: stores.name,
        roleName:  roles.name,
        expiresAt: invitations.expiresAt,
      })
      .from(invitations)
      .innerJoin(stores, eq(invitations.storeFk, stores.id))
      .innerJoin(roles, eq(invitations.roleFk, roles.id))
      .where(
        and(
          eq(invitations.status, 'pending'),
          gt(invitations.expiresAt, new Date()),
          or(...contactMatch),
        ),
      );

    return rows;
  }

  async findContactForUser(userId: string): Promise<{ phone: string | null; email: string | null } | null> {
    const [row] = await this.db
      .select({ phone: users.phone, email: users.email })
      .from(users)
      .where(eq(users.id, userId));
    return row ?? null;
  }
}
