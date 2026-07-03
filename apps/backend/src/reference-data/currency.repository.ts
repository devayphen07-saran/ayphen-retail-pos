import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DRIZZLE, type DbExecutor } from '#db/db.module.js';
import * as schema from '#db/schema.js';
import { currency } from '#db/schema.js';

export interface CurrencyRow {
  id:       string;
  code:     string;
  name:     string;
  symbol:   string;
  isActive: boolean;
}

@Injectable()
export class CurrencyRepository {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>,
  ) {}

  private client(tx?: DbExecutor) {
    return tx ?? this.db;
  }

  async listActive(tx?: DbExecutor): Promise<CurrencyRow[]> {
    return this.client(tx).select().from(currency).where(eq(currency.isActive, true));
  }
}