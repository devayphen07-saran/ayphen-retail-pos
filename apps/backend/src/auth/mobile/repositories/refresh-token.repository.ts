import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DRIZZLE, type DbExecutor } from '#db/db.module.js';
import { requireRow } from '#db/require-row.js';
import * as schema from '#db/schema.js';
import { refreshTokens, deviceSessions, users } from '#db/schema.js';

export type RefreshToken = typeof refreshTokens.$inferSelect;

export interface RefreshTokenWithSession extends RefreshToken {
  session: typeof deviceSessions.$inferSelect;
  user:    typeof users.$inferSelect;
}

@Injectable()
export class RefreshTokenRepository {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>,
  ) {}

  async insert(
    data: typeof refreshTokens.$inferInsert,
    tx?: DbExecutor,
  ): Promise<RefreshToken> {
    const [row] = await (tx ?? this.db).insert(refreshTokens).values(data).returning();
    return requireRow(row);
  }

  async findByHash(tokenHash: string): Promise<RefreshTokenWithSession | null> {
    const [row] = await this.db
      .select()
      .from(refreshTokens)
      .innerJoin(deviceSessions, eq(refreshTokens.deviceSessionFk, deviceSessions.id))
      .innerJoin(users, eq(deviceSessions.userFk, users.id))
      .where(eq(refreshTokens.tokenHash, tokenHash));
    if (!row) return null;
    return { ...row.refresh_tokens, session: row.device_sessions, user: row.users };
  }

  /**
   * Compare-and-swap: only marks the row used if it isn't already. Two
   * concurrent rotations racing the same token can both pass an earlier
   * `usedAt` read outside the transaction — this WHERE clause is what
   * actually decides which one wins, so the loser's caller must react to a
   * `false` return (reuse) rather than assuming success.
   */
  async markUsed(id: string, tx?: DbExecutor): Promise<boolean> {
    const rows = await (tx ?? this.db)
      .update(refreshTokens)
      .set({ usedAt: new Date() })
      .where(and(eq(refreshTokens.id, id), isNull(refreshTokens.usedAt)))
      .returning({ id: refreshTokens.id });
    return rows.length > 0;
  }

  /** Fresh read of a token's usedAt — used by the CAS loser to distinguish a
   *  seconds-old concurrent rotation (grace → retry signal) from a genuinely
   *  stale token being replayed (reuse attack → family revocation). */
  async findUsedAt(id: string, tx?: DbExecutor): Promise<Date | null> {
    const [row] = await (tx ?? this.db)
      .select({ usedAt: refreshTokens.usedAt })
      .from(refreshTokens)
      .where(eq(refreshTokens.id, id));
    return row?.usedAt ?? null;
  }

  async revokeFamily(familyId: string, reason: string, tx?: DbExecutor): Promise<void> {
    await (tx ?? this.db)
      .update(refreshTokens)
      .set({ revokedAt: new Date(), revokedReason: reason })
      .where(and(eq(refreshTokens.familyId, familyId), isNull(refreshTokens.revokedAt)));
  }

  async revokeBySession(deviceSessionFk: string, reason: string, tx?: DbExecutor): Promise<void> {
    await (tx ?? this.db)
      .update(refreshTokens)
      .set({ revokedAt: new Date(), revokedReason: reason })
      .where(and(
        eq(refreshTokens.deviceSessionFk, deviceSessionFk),
        isNull(refreshTokens.revokedAt),
      ));
  }
}
