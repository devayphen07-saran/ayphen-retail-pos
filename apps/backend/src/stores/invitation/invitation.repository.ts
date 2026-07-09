import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gt, or, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DRIZZLE, type DbExecutor } from '#db/db.module.js';
import { requireRow } from '#db/require-row.js';
import * as schema from '#db/schema.js';
import {
  invitations,
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
   * Lock the store row for the duration of the transaction (SELECT ... FOR
   * UPDATE). Serializes concurrent invitation-creation attempts against the
   * same store so the expire-then-insert sequence in create() can't race.
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

  /**
   * Lazily flip stale (expired but never accepted/revoked) pending invites for
   * this exact store+role+contact out of 'pending' — nothing else in this
   * codebase transitions status='expired' on a schedule, so a pending row
   * whose expiresAt has lapsed would otherwise sit there forever and collide
   * with uk_invitations_pending_phone/email on a legitimate re-invite. Must
   * run inside the same transaction/lock as the insert that follows it.
   */
  async expireStalePending(
    storeId: string,
    roleId: string,
    phone: string | undefined,
    email: string | undefined,
    tx: DbExecutor,
  ): Promise<void> {
    const contactMatch = [];
    if (phone) contactMatch.push(eq(invitations.phone, phone));
    if (email) contactMatch.push(eq(invitations.email, email));
    if (contactMatch.length === 0) return;

    await tx
      .update(invitations)
      .set({ status: 'expired' })
      .where(and(
        eq(invitations.storeFk, storeId),
        eq(invitations.roleFk, roleId),
        eq(invitations.status, 'pending'),
        sql`${invitations.expiresAt} <= now()`,
        or(...contactMatch),
      ));
  }

  /** Live (pending, unexpired) invitations still pointing at this role — used
   *  to block role deletion so an invite can't later 404 with ROLE_NOT_FOUND
   *  at accept-time instead of being blocked up front. */
  async countActivePendingForRole(roleId: string, tx?: DbExecutor): Promise<number> {
    const [row] = await this.client(tx)
      .select({ n: sql<number>`count(*)::int` })
      .from(invitations)
      .where(and(
        eq(invitations.roleFk, roleId),
        eq(invitations.status, 'pending'),
        gt(invitations.expiresAt, new Date()),
      ));
    return row?.n ?? 0;
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
      )
      // Defensive cap, not real pagination — a person's own pending invites
      // are structurally small (bounded by how many stores could plausibly
      // invite the same phone/email), but "no LIMIT at all" is still a bug
      // per the standard's "bound everything" rule.
      .limit(500);

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
