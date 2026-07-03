import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DRIZZLE, type DbExecutor } from '#db/db.module.js';
import * as schema from '#db/schema.js';
import { country } from '#db/schema.js';

export interface CountryRow {
  id:           string;
  code:         string;
  name:         string;
  callingCode:  string | null;
  isActive:     boolean;
}

@Injectable()
export class CountryRepository {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>,
  ) {}

  private client(tx?: DbExecutor) {
    return tx ?? this.db;
  }

  async listActive(tx?: DbExecutor): Promise<CountryRow[]> {
    return this.client(tx).select().from(country).where(eq(country.isActive, true));
  }
}