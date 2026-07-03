import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gt, isNull, or, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DRIZZLE, type DbExecutor } from '#db/db.module.js';
import * as schema from '#db/schema.js';
import {
  invitations,
  userRoleMappings,
  accountUsers,
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

export interface PendingInvitationRow {
  id:        string;
  token:     string;
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
    return row!;
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

  async markAccepted(
    invitationId: string,
    userId: string,
    tx?: DbExecutor,
  ): Promise<void> {
    await this.client(tx)
      .update(invitations)
      .set({ status: 'accepted', acceptedBy: userId, acceptedAt: new Date() })
      .where(eq(invitations.id, invitationId));
  }

  /** Invitee declines — same terminal state as a store revoking it. */
  async markRevoked(invitationId: string, tx?: DbExecutor): Promise<void> {
    await this.client(tx)
      .update(invitations)
      .set({ status: 'revoked' })
      .where(eq(invitations.id, invitationId));
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
        token:     invitations.token,
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
