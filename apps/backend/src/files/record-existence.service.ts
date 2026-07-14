import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DRIZZLE, type DbExecutor } from '#db/db.module.js';
import * as schema from '#db/schema.js';
import { products, files, supplierPayments } from '#db/schema.js';

/**
 * A store-scoped, soft-deletable, synced parent table an attachment can point at.
 * Every entry is a table exposing the standard sync columns (`guuid`, `store_fk`)
 * plus `deleted_at`, so the existence query is uniform across entities.
 */
interface RecordTable {
  table: PgTable;
  guuid: PgColumn;
  storeFk: PgColumn;
  deletedAt: PgColumn;
}

/**
 * The registry of entity code → parent table. Attachments are polymorphic
 * (`files.record_guuid` has no FK), so parent existence can't be a DB constraint;
 * it is verified here at commit time. **Fail-closed:** an entity absent from this
 * map cannot be committed against (ParentVerificationUnavailableError) — add its
 * table here when that surface ships. Product is the first (and today only)
 * image surface.
 */
const RECORD_TABLES: Record<string, RecordTable> = {
  Product: {
    table: products,
    guuid: products.guuid,
    storeFk: products.storeFk,
    deletedAt: products.deletedAt,
  },
  // Signature-of-receipt image (F6, docs/prd/accounts-and-ledger.md) — the
  // parent is the payment itself, not the supplier. `deleted_at` is always
  // null (append-only; see schema.ts's comment on the column).
  SupplierPayment: {
    table: supplierPayments,
    guuid: supplierPayments.guuid,
    storeFk: supplierPayments.storeFk,
    deletedAt: supplierPayments.deletedAt,
  },
};

/**
 * Verifies that an attachment's polymorphic parent record actually exists, is
 * live (not soft-deleted), and belongs to the calling store — the server-enforced
 * invariant behind commit (image-offline-architecture.md P1-12a). It is both an
 * integrity control (no phantom `files` rows) and an isolation control (can't
 * attach to another store's record).
 */
@Injectable()
export class RecordExistenceService {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>,
  ) {}

  private client(tx?: DbExecutor) {
    return tx ?? this.db;
  }

  /** Whether we can verify parents for this entity at all (a resolver is registered). */
  supports(entityTypeCode: string): boolean {
    return Object.prototype.hasOwnProperty.call(RECORD_TABLES, entityTypeCode);
  }

  /** Entity codes with a registered resolver — the reaper only audits these. */
  registeredCodes(): string[] {
    return Object.keys(RECORD_TABLES);
  }

  /**
   * Committed files whose parent no longer resolves to a live record (P1-12b).
   * A LEFT JOIN to the parent table keeping only rows with no live match — the
   * orphan-`files` reaper's work list. With the commit parent-check in place this
   * should be empty; running it is how the invariant is *proven*, not assumed.
   */
  async findOrphanedFiles(
    entityTypeCode: string,
    entityTypeFk: string,
    limit: number,
    tx?: DbExecutor,
  ): Promise<{ guuid: string; storageKey: string }[]> {
    const entry = RECORD_TABLES[entityTypeCode];
    if (!entry) return [];
    return this.client(tx)
      .select({ guuid: files.guuid, storageKey: files.storageKey })
      .from(files)
      .leftJoin(
        entry.table,
        and(eq(entry.guuid, files.recordGuuid), isNull(entry.deletedAt)),
      )
      .where(
        and(
          eq(files.entityTypeFk, entityTypeFk),
          isNull(files.deletedAt),
          isNull(entry.guuid), // no live parent matched the join
        ),
      )
      .limit(limit);
  }

  /**
   * True iff a live record with `guuid` exists in `store`. Throws if the entity
   * has no registered resolver (fail-closed — never silently allow an unverifiable
   * parent).
   */
  async exists(
    entityTypeCode: string,
    recordGuuid: string,
    storeId: string,
    tx?: DbExecutor,
  ): Promise<boolean> {
    const entry = RECORD_TABLES[entityTypeCode];
    if (!entry) return false; // caller distinguishes "unsupported" via supports()
    const [row] = await this.client(tx)
      .select({ one: sql`1` })
      .from(entry.table)
      .where(
        and(
          eq(entry.guuid, recordGuuid),
          eq(entry.storeFk, storeId),
          isNull(entry.deletedAt),
        ),
      )
      .limit(1);
    return Boolean(row);
  }
}
