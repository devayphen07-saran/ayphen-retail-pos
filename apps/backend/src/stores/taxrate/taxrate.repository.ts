import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DRIZZLE, type DbExecutor } from '#db/db.module.js';
import { requireRow } from '#db/require-row.js';
import * as schema from '#db/schema.js';
import { taxRates } from '#db/schema.js';

/** A tax-rate row as read back for the wire mapper. `ratePercent` is a string
 *  (drizzle `numeric`) to keep the exact `numeric(6,3)` value. */
export interface TaxRateRow {
  id:          string;
  name:        string;
  ratePercent: string;
  isInclusive: boolean;
  isActive:    boolean;
  guuid:       string;
  rowVersion:  number;
}

const ROW = {
  id:          taxRates.id,
  name:        taxRates.name,
  ratePercent: taxRates.ratePercent,
  isInclusive: taxRates.isInclusive,
  isActive:    taxRates.isActive,
  guuid:       taxRates.guuid,
  rowVersion:  taxRates.rowVersion,
} as const;

@Injectable()
export class TaxRateRepository {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>,
  ) {}

  private client(tx?: DbExecutor) {
    return tx ?? this.db;
  }

  /** Every live tax rate in a store (active and inactive). Bounded — a store
   *  has at most a handful of tax rates — but capped defensively. */
  async listInStore(storeId: string, tx?: DbExecutor): Promise<TaxRateRow[]> {
    return this.client(tx)
      .select(ROW)
      .from(taxRates)
      .where(and(eq(taxRates.storeFk, storeId), isNull(taxRates.deletedAt)))
      .limit(200);
  }

  async findInStore(
    id: string,
    storeId: string,
    tx?: DbExecutor,
  ): Promise<TaxRateRow | null> {
    const [row] = await this.client(tx)
      .select(ROW)
      .from(taxRates)
      .where(
        and(
          eq(taxRates.id, id),
          eq(taxRates.storeFk, storeId),
          isNull(taxRates.deletedAt),
        ),
      );
    return row ?? null;
  }

  /** True if a live rate with this name (case-insensitive) already exists in the
   *  store. `excludeId` skips the row being edited so a no-op rename passes. */
  async nameTaken(
    storeId: string,
    name: string,
    excludeId: string | null,
    tx?: DbExecutor,
  ): Promise<boolean> {
    const [row] = await this.client(tx)
      .select({ id: taxRates.id })
      .from(taxRates)
      .where(
        and(
          eq(taxRates.storeFk, storeId),
          sql`lower(${taxRates.name}) = lower(${name})`,
          isNull(taxRates.deletedAt),
          excludeId ? ne(taxRates.id, excludeId) : undefined,
        ),
      )
      .limit(1);
    return !!row;
  }

  async create(
    data: {
      storeFk: string;
      name: string;
      ratePercent: string;
      isInclusive: boolean;
      createdBy: string;
    },
    tx?: DbExecutor,
  ): Promise<TaxRateRow> {
    const [row] = await this.client(tx)
      .insert(taxRates)
      .values({
        storeFk:     data.storeFk,
        name:        data.name,
        ratePercent: data.ratePercent,
        isInclusive: data.isInclusive,
        createdBy:   data.createdBy,
        updatedBy:   data.createdBy,
      })
      .returning(ROW);
    return requireRow(row);
  }

  /**
   * Optimistic-locked update: matches on `(id, storeFk, rowVersion)` among live
   * rows. Returns the updated row, or null when nothing matched (either the row
   * is gone or the version is stale — the caller disambiguates). `rowVersion` is
   * bumped by the `sync_touch_row` trigger, not here.
   */
  async updateWithVersion(
    id: string,
    storeId: string,
    expectedRowVersion: number,
    fields: { name: string; ratePercent: string; isInclusive: boolean },
    userId: string,
    tx?: DbExecutor,
  ): Promise<TaxRateRow | null> {
    const [row] = await this.client(tx)
      .update(taxRates)
      .set({
        name:        fields.name,
        ratePercent: fields.ratePercent,
        isInclusive: fields.isInclusive,
        updatedBy:   userId,
      })
      .where(
        and(
          eq(taxRates.id, id),
          eq(taxRates.storeFk, storeId),
          eq(taxRates.rowVersion, expectedRowVersion),
          isNull(taxRates.deletedAt),
        ),
      )
      .returning(ROW);
    return row ?? null;
  }

  /** Deactivate a live rate (hide from new selection; keeps it valid for
   *  products that still reference it). A normal UPDATE — the trigger bumps
   *  `rowVersion`/`modifiedAt` so the change pulls to devices. */
  async deactivate(
    id: string,
    storeId: string,
    userId: string,
    tx?: DbExecutor,
  ): Promise<TaxRateRow | null> {
    const [row] = await this.client(tx)
      .update(taxRates)
      .set({ isActive: false, updatedBy: userId })
      .where(
        and(
          eq(taxRates.id, id),
          eq(taxRates.storeFk, storeId),
          eq(taxRates.isActive, true),
          isNull(taxRates.deletedAt),
        ),
      )
      .returning(ROW);
    return row ?? null;
  }
}