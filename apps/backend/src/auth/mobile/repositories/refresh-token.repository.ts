import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DRIZZLE, type DbExecutor } from '../../../db/db.module.js';
import * as schema from '../../../db/schema.js';
import { refreshTokens, deviceSessions, users } from '../../../db/schema.js';

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
    return row!;
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

  async markUsed(id: string): Promise<void> {
    await this.db
      .update(refreshTokens)
      .set({ usedAt: new Date() })
      .where(eq(refreshTokens.id, id));
  }

  async revokeFamily(familyId: string, reason: string): Promise<void> {
    await this.db
      .update(refreshTokens)
      .set({ revokedAt: new Date(), revokedReason: reason })
      .where(and(eq(refreshTokens.familyId, familyId), isNull(refreshTokens.revokedAt)));
  }

  async revokeBySession(deviceSessionFk: string, reason: string): Promise<void> {
    await this.db
      .update(refreshTokens)
      .set({ revokedAt: new Date(), revokedReason: reason })
      .where(and(
        eq(refreshTokens.deviceSessionFk, deviceSessionFk),
        isNull(refreshTokens.revokedAt),
      ));
  }
}
