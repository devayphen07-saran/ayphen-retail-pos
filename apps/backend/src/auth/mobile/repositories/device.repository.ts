import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
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

  async findById(id: string): Promise<Device | null> {
    const [row] = await this.db.select().from(devices).where(eq(devices.id, id));
    return row ?? null;
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
}
