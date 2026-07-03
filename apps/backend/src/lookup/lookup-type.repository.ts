import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DRIZZLE, type DbExecutor } from '#db/db.module.js';
import * as schema from '#db/schema.js';
import { lookupType } from '#db/schema.js';

export interface LookupTypeRow {
  id:          string;
  code:        string;
  title:       string;
  description: string | null;
  isActive:    boolean;
}

@Injectable()
export class LookupTypeRepository {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>,
  ) {}

  private client(tx?: DbExecutor) {
    return tx ?? this.db;
  }

  async findByCode(code: string, tx?: DbExecutor): Promise<LookupTypeRow | null> {
    const [row] = await this.client(tx)
      .select()
      .from(lookupType)
      .where(eq(lookupType.code, code));
    return row ?? null;
  }

  async listAll(tx?: DbExecutor): Promise<LookupTypeRow[]> {
    return this.client(tx).select().from(lookupType);
  }

  async create(
    data: typeof lookupType.$inferInsert,
    tx?: DbExecutor,
  ): Promise<LookupTypeRow> {
    const [row] = await this.client(tx).insert(lookupType).values(data).returning();
    return row!;
  }
}
