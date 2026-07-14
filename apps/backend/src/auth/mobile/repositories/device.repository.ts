import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DRIZZLE, type DbExecutor } from '#db/db.module.js';
import { requireRow } from '#db/require-row.js';
import * as schema from '#db/schema.js';
import { devices } from '#db/schema.js';

export type Device = typeof devices.$inferSelect;

@Injectable()
export class DeviceRepository {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>,
  ) {}

  async findByUserAndKeyHash(
    userFk: string,
    publicKeyHash: string,
    tx?: DbExecutor,
  ): Promise<Device | null> {
    const [row] = await (tx ?? this.db)
      .select()
      .from(devices)
      .where(and(eq(devices.userFk, userFk), eq(devices.publicKeyHash, publicKeyHash)));
    return row ?? null;
  }

  /** Unscoped by ownership/tenant — caller MUST verify the caller is authorized to read this id before use. */
  async findById(id: string): Promise<Device | null> {
    const [row] = await this.db.select().from(devices).where(eq(devices.id, id));
    return row ?? null;
  }

  /** A device owned by this user, or null (ownership guard for block/unblock). */
  async findOwnedByUser(id: string, userFk: string): Promise<Device | null> {
    const [row] = await this.db
      .select()
      .from(devices)
      .where(and(eq(devices.id, id), eq(devices.userFk, userFk)));
    return row ?? null;
  }

  /** All devices registered to a user (My Devices, F7). */
  async listByUser(userFk: string): Promise<Device[]> {
    return this.db
      .select()
      .from(devices)
      .where(eq(devices.userFk, userFk))
      .orderBy(desc(devices.lastSeenAt));
  }

  async insert(
    data: typeof devices.$inferInsert,
    tx?: DbExecutor,
  ): Promise<Device> {
    const [row] = await (tx ?? this.db).insert(devices).values(data).returning();
    return requireRow(row);
  }

  async update(
    id: string,
    data: Partial<typeof devices.$inferInsert>,
    tx?: DbExecutor,
  ): Promise<void> {
    await (tx ?? this.db).update(devices).set(data).where(eq(devices.id, id));
  }

  /** Block/unblock a device (F8). Blocking also clears trust and the push token (BR-DEV-014). */
  async setBlocked(id: string, blocked: boolean, tx?: DbExecutor): Promise<void> {
    await (tx ?? this.db)
      .update(devices)
      .set({
        isBlocked: blocked,
        isTrusted: blocked ? false : undefined,
        blockedAt: blocked ? new Date() : null,
        pushToken: blocked ? null : undefined,
      })
      .where(eq(devices.id, id));
  }
}
