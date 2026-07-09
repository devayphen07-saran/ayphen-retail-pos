import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DRIZZLE, type DbExecutor } from '#db/db.module.js';
import { requireRow } from '#db/require-row.js';
import * as schema from '#db/schema.js';
import { users, files } from '#db/schema.js';
import type { ProfileResult } from '../types/auth-result.js';

export type User = typeof users.$inferSelect;

/**
 * Data access for the `users` aggregate on the mobile-auth track. The only
 * layer permitted to touch the table — services orchestrate these calls but
 * never issue raw Drizzle queries themselves.
 */
@Injectable()
export class UserRepository {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>,
  ) {}

  async findByPhone(phone: string, tx?: DbExecutor): Promise<User | null> {
    const [row] = await (tx ?? this.db).select().from(users).where(eq(users.phone, phone));
    return row ?? null;
  }

  async findById(id: string, tx?: DbExecutor): Promise<User | null> {
    const [row] = await (tx ?? this.db).select().from(users).where(eq(users.id, id));
    return row ?? null;
  }

  async insert(data: typeof users.$inferInsert, tx?: DbExecutor): Promise<User> {
    const [row] = await (tx ?? this.db).insert(users).values(data).returning();
    return requireRow(row);
  }

  async setAccountMode(
    id: string,
    mode: 'business' | 'personal',
    tx?: DbExecutor,
  ): Promise<void> {
    await (tx ?? this.db).update(users).set({ lastAccountMode: mode }).where(eq(users.id, id));
  }

  /** Partial write — only the keys the caller actually supplied are touched;
   *  an omitted field is left as-is, never nulled out. Throws the raw
   *  Postgres 23505 on an email collision; the service translates it. */
  async updateProfile(
    id: string,
    patch: { name?: string; email?: string },
    tx?: DbExecutor,
  ): Promise<void> {
    const set: Partial<typeof users.$inferInsert> = {};
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.email !== undefined) set.email = patch.email;
    if (Object.keys(set).length === 0) return;
    await (tx ?? this.db).update(users).set(set).where(eq(users.id, id));
  }

  /**
   * Atomic read-modify-write: increment `failed_login_attempts` in the DB and
   * RETURN the new value, so concurrent failed attempts can't lose an increment
   * (a read-then-set would). Callers decide whether the fresh count crosses the
   * lockout threshold.
   */
  async incrementFailedAttempts(id: string, tx?: DbExecutor): Promise<number> {
    const [row] = await (tx ?? this.db)
      .update(users)
      .set({ failedLoginAttempts: sql`${users.failedLoginAttempts} + 1` })
      .where(eq(users.id, id))
      .returning({ attempts: users.failedLoginAttempts });
    return row?.attempts ?? 0;
  }

  async applyLockout(id: string, lockedUntil: Date, tx?: DbExecutor): Promise<void> {
    await (tx ?? this.db)
      .update(users)
      .set({ accountLockedUntil: lockedUntil, status: 'locked' })
      .where(eq(users.id, id));
  }

  /**
   * Reset login-failure state and stamp a successful login (§18.9). Clears the
   * failed-attempts lockout ('locked') back to 'active' — that's the intended
   * recovery path — but never touches an admin-applied 'suspended' status;
   * only an explicit admin action may lift that. Defense in depth: the
   * caller (AuthLoginService.loginStageTwo) already rejects a suspended user
   * before this runs, but this method must never silently clear it either way.
   */
  async markSuccessfulLogin(id: string, tx?: DbExecutor): Promise<void> {
    await (tx ?? this.db)
      .update(users)
      .set({
        failedLoginAttempts: 0,
        accountLockedUntil:  null,
        status:              sql`CASE WHEN ${users.status} = 'suspended' THEN ${users.status} ELSE 'active' END`,
        lastLoginAt:         new Date(),
        phoneVerified:       true,
      })
      .where(eq(users.id, id));
  }

  /**
   * Display data for GET /me/profile. The join filters out a soft-deleted
   * `files` row (e.g. a picture replaced/removed) so it correctly resolves to
   * `profilePictureUrl: null` instead of a dead URL.
   */
  async findProfile(id: string, tx?: DbExecutor): Promise<ProfileResult | null> {
    const [row] = await (tx ?? this.db)
      .select({
        name:              users.name,
        email:             users.email,
        phone:             users.phone,
        phoneVerified:     users.phoneVerified,
        profilePictureUrl: files.storageUrl,
      })
      .from(users)
      .leftJoin(
        files,
        and(eq(files.id, users.imageAttachmentFk), isNull(files.deletedAt)),
      )
      .where(eq(users.id, id));
    if (!row) return null;
    return { ...row, profilePictureUrl: row.profilePictureUrl ?? null };
  }
}
