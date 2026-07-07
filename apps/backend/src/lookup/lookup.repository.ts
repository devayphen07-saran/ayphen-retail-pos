import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DRIZZLE, type DbExecutor } from '#db/db.module.js';
import { requireRow } from '#db/require-row.js';
import * as schema from '#db/schema.js';
import { lookup } from '#db/schema.js';

export interface LookupValueRow {
  id:           string;
  guuid:        string;
  lookupTypeFk: string;
  storeFk:      string | null;
  code:         string;
  label:        string;
  description:  string | null;
  sortOrder:    number;
  isHidden:     boolean;
  isSystem:     boolean;
  isActive:     boolean;
  rowVersion:   number;
}

@Injectable()
export class LookupRepository {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>,
  ) {}

  private client(tx?: DbExecutor) {
    return tx ?? this.db;
  }

  /**
   * Dropdown values for a type: global + this store's, active, non-hidden
   * (BR-3). Defensive cap, not real pagination — this feeds a plain-array
   * dropdown the mobile client renders in full; there's currently no cap on
   * how many custom values a store can create per type, so an unbounded
   * query here is a real "bound everything" gap.
   */
  async listByType(
    typeId: string,
    storeId: string | null,
    tx?: DbExecutor,
  ): Promise<LookupValueRow[]> {
    return this.client(tx)
      .select()
      .from(lookup)
      .where(
        and(
          eq(lookup.lookupTypeFk, typeId),
          eq(lookup.isActive, true),
          eq(lookup.isHidden, false),
          storeId
            ? or(isNull(lookup.storeFk), eq(lookup.storeFk, storeId))
            : isNull(lookup.storeFk),
        ),
      )
      .orderBy(lookup.sortOrder)
      .limit(500);
  }

  async findByGuuid(guuid: string, tx?: DbExecutor): Promise<LookupValueRow | null> {
    const [row] = await this.client(tx).select().from(lookup).where(eq(lookup.guuid, guuid));
    return row ?? null;
  }

  /** BR-4 guard: a code must be unique within its type, across all stores. */
  async existsByTypeAndCode(
    typeId: string,
    code: string,
    tx?: DbExecutor,
  ): Promise<boolean> {
    const [row] = await this.client(tx)
      .select({ id: lookup.id })
      .from(lookup)
      .where(and(eq(lookup.lookupTypeFk, typeId), eq(lookup.code, code)));
    return !!row;
  }

  async insertValue(
    data: typeof lookup.$inferInsert,
    tx?: DbExecutor,
  ): Promise<LookupValueRow> {
    const [row] = await this.client(tx).insert(lookup).values(data).returning();
    return requireRow(row);
  }

  async updateValue(
    guuid: string,
    storeId: string,
    expectedRowVersion: number,
    patch: Partial<typeof lookup.$inferInsert>,
    tx?: DbExecutor,
  ): Promise<LookupValueRow | null> {
    // storeFk, is_system, AND row_version are all filtered in SQL (not just
    // the service's loadEditableValue pre-check) — tenant-scoped,
    // system-value-protected, and optimistic-locked in one atomic statement,
    // matching the sync-push mutation handler's guard for this same table.
    const [row] = await this.client(tx)
      .update(lookup)
      .set({ ...patch, rowVersion: sql`${lookup.rowVersion} + 1`, updatedAt: new Date() })
      .where(and(
        eq(lookup.guuid, guuid),
        eq(lookup.storeFk, storeId),
        eq(lookup.isSystem, false),
        eq(lookup.rowVersion, expectedRowVersion),
      ))
      .returning();
    return row ?? null;
  }

  /** BR-6: deleting a value is a soft-delete. */
  async softDeleteValue(guuid: string, storeId: string, tx?: DbExecutor): Promise<void> {
    await this.client(tx)
      .update(lookup)
      .set({ isActive: false, updatedAt: new Date() })
      .where(and(
        eq(lookup.guuid, guuid),
        eq(lookup.storeFk, storeId),
        eq(lookup.isSystem, false),
      ));
  }
}
