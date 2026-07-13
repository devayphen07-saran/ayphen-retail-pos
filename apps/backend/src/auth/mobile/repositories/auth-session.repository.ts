import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gt, isNull, type SQL } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DRIZZLE, type DbExecutor } from '#db/db.module.js';
import { requireRow } from '#db/require-row.js';
import * as schema from '#db/schema.js';
import { deviceSessions, devices } from '#db/schema.js';
import { paginateByCursor, type CursorPage } from '#common/pagination/paginate.js';

export type DeviceSession = typeof deviceSessions.$inferSelect;

export interface SessionWithDevice extends DeviceSession {
  device: typeof devices.$inferSelect;
}

@Injectable()
export class AuthSessionRepository {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>,
  ) {}

  async create(
    data: {
      userFk: string;
      deviceFk: string;
      expiresAt: Date;
      ipAtCreation: string;
      appVersion?: string;
      platform?: string;
      pushToken?: string;
    },
    tx?: DbExecutor,
  ): Promise<DeviceSession> {
    const [row] = await (tx ?? this.db)
      .insert(deviceSessions)
      .values(data)
      .returning();
    return requireRow(row);
  }

  /** Unscoped by ownership/tenant — caller MUST verify the caller is authorized to read this id before use. */
  async findById(id: string): Promise<DeviceSession | null> {
    const [row] = await this.db
      .select()
      .from(deviceSessions)
      .where(eq(deviceSessions.id, id));
    return row ?? null;
  }

  async revokeSession(id: string, reason = 'user_logout', tx?: DbExecutor): Promise<void> {
    await (tx ?? this.db)
      .update(deviceSessions)
      .set({ revokedAt: new Date(), revokedReason: reason })
      .where(eq(deviceSessions.id, id));
  }

  async revokeAllUserSessions(userFk: string, reason: string, tx?: DbExecutor): Promise<void> {
    await (tx ?? this.db)
      .update(deviceSessions)
      .set({ revokedAt: new Date(), revokedReason: reason })
      .where(
        and(
          eq(deviceSessions.userFk, userFk),
          isNull(deviceSessions.revokedAt),
        ),
      );
  }

  async updateLastUsed(id: string, tx?: DbExecutor): Promise<void> {
    await (tx ?? this.db)
      .update(deviceSessions)
      .set({ lastUsedAt: new Date() })
      .where(eq(deviceSessions.id, id));
  }

  async updateStepUp(
    id: string,
    method: NonNullable<DeviceSession['lastStepUpMethod']>,
    at: Date,
    tx?: DbExecutor,
  ): Promise<void> {
    await (tx ?? this.db)
      .update(deviceSessions)
      .set({
        lastStepUpAt: at,
        lastStepUpMethod: method,
      })
      .where(eq(deviceSessions.id, id));
  }

  async setStepUpLockedUntil(id: string, until: Date, tx?: DbExecutor): Promise<void> {
    await (tx ?? this.db)
      .update(deviceSessions)
      .set({ stepUpLockedUntil: until })
      .where(eq(deviceSessions.id, id));
  }

  async updateCurrentJti(id: string, jti: string, exp: Date, tx?: DbExecutor): Promise<void> {
    await (tx ?? this.db)
      .update(deviceSessions)
      .set({ currentJti: jti, currentJtiExp: exp })
      .where(eq(deviceSessions.id, id));
  }

  /** Cursor-paginated list of a user's active sessions, newest first. */
  async listActiveSessions(
    userFk: string,
    page: { limit: number; cursor?: string },
  ): Promise<CursorPage<SessionWithDevice>> {
    const base = and(
      eq(deviceSessions.userFk, userFk),
      isNull(deviceSessions.revokedAt),
      gt(deviceSessions.expiresAt, new Date()),
    );

    return paginateByCursor<SessionWithDevice>({
      cursor:     page.cursor,
      limit:      page.limit,
      sortColumn: deviceSessions.createdAt,
      tieColumn:  deviceSessions.id,
      sortValue:  (s) => s.createdAt.toISOString(),
      idValue:    (s) => s.id,
      fetch: async (keyset: SQL | undefined, take: number) => {
        const rows = await this.db
          .select()
          .from(deviceSessions)
          .innerJoin(devices, eq(deviceSessions.deviceFk, devices.id))
          .where(keyset ? and(base, keyset) : base)
          .orderBy(desc(deviceSessions.createdAt), desc(deviceSessions.id))
          .limit(take);
        return rows.map((r) => ({ ...r.device_sessions, device: r.devices }));
      },
    });
  }

  /** Single active session scoped to its owner — for ownership checks. */
  async findActiveByIdForUser(
    id: string,
    userFk: string,
  ): Promise<DeviceSession | null> {
    const [row] = await this.db
      .select()
      .from(deviceSessions)
      .where(
        and(
          eq(deviceSessions.id, id),
          eq(deviceSessions.userFk, userFk),
          isNull(deviceSessions.revokedAt),
          gt(deviceSessions.expiresAt, new Date()),
        ),
      );
    return row ?? null;
  }

  async listActiveSessionsWithJti(userFk: string): Promise<DeviceSession[]> {
    return this.db
      .select()
      .from(deviceSessions)
      .where(
        and(
          eq(deviceSessions.userFk, userFk),
          isNull(deviceSessions.revokedAt),
          gt(deviceSessions.expiresAt, new Date()),
        ),
      );
  }
}
