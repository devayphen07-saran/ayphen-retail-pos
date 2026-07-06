import { Inject, Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DRIZZLE, type DbExecutor } from '#db/db.module.js';
import { requireRow } from '#db/require-row.js';
import * as schema from '#db/schema.js';
import { users } from '#db/schema.js';

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

  /** Reset login-failure state and stamp a successful login (§18.9). */
  async markSuccessfulLogin(id: string, tx?: DbExecutor): Promise<void> {
    await (tx ?? this.db)
      .update(users)
      .set({
        failedLoginAttempts: 0,
        accountLockedUntil:  null,
        status:              'active',
        lastLoginAt:         new Date(),
        phoneVerified:       true,
      })
      .where(eq(users.id, id));
  }
}
