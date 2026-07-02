import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DRIZZLE, type DbExecutor } from '../db/db.module.js';
import * as schema from '../db/schema.js';
import {
  invitations,
  userRoleMappings,
  accountUsers,
  stores,
} from '../db/schema.js';

export interface InvitationRow {
  id:       string;
  storeFk:  string;
  roleFk:   string;
  status:   string;
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
}
