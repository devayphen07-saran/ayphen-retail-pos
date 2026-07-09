import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DRIZZLE, type DbExecutor } from '#db/db.module.js';
import * as schema from '#db/schema.js';
import { files, temporaryFiles } from '#db/schema.js';

export type TempFileRow = typeof temporaryFiles.$inferSelect;
export type FileRow = typeof files.$inferSelect;
export type NewTempFile = typeof temporaryFiles.$inferInsert;
export type NewFile = typeof files.$inferInsert;

/**
 * Data access for the two-phase upload (table-architecture §33).
 *
 * Isolation invariant (Part C §C5): committed `files` reads/writes are ALWAYS
 * store-scoped; staged `temporary_files` reads/deletes are ALWAYS owner-scoped
 * (`uploaded_by`). No method exposes a lookup by key/guuid alone — that is the
 * cross-tenant hole the old Java app had.
 */
@Injectable()
export class FilesRepository {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>,
  ) {}

  private client(tx?: DbExecutor) {
    return tx ?? this.db;
  }

  // ── Staging (temporary_files) ──────────────────────────────────────────

  async insertTemp(row: NewTempFile, tx?: DbExecutor): Promise<TempFileRow> {
    const [inserted] = await this.client(tx).insert(temporaryFiles).values(row).returning();
    return inserted;
  }

  /** Owner-scoped: a user can only ever see their own staged files. */
  async findTempByGuuid(guuid: string, uploadedBy: string, tx?: DbExecutor): Promise<TempFileRow | null> {
    const [row] = await this.client(tx)
      .select()
      .from(temporaryFiles)
      .where(and(eq(temporaryFiles.guuid, guuid), eq(temporaryFiles.uploadedBy, uploadedBy)));
    return row ?? null;
  }

  /** Owner-scoped batch lookup — resolve many staged temps in one round trip.
   *  Rows come back in arbitrary order; the caller re-orders by guuid. */
  async findTempsByGuuids(guuids: string[], uploadedBy: string, tx?: DbExecutor): Promise<TempFileRow[]> {
    if (guuids.length === 0) return [];
    return this.client(tx)
      .select()
      .from(temporaryFiles)
      .where(and(inArray(temporaryFiles.guuid, guuids), eq(temporaryFiles.uploadedBy, uploadedBy)));
  }

  async deleteTempById(id: string, tx?: DbExecutor): Promise<void> {
    await this.client(tx).delete(temporaryFiles).where(eq(temporaryFiles.id, id));
  }

  /**
   * Atomic commit gate (schema §33 `claimed_at`): flip an owner's still-unclaimed
   * temp to claimed in one statement. Two concurrent commits of the same upload
   * race on this UPDATE — only the one that sees `claimed_at IS NULL` wins and
   * gets the row back; the loser gets null and must abort. Prevents a staged
   * upload from being committed twice into duplicate `files` rows.
   */
  async claimTemp(guuid: string, uploadedBy: string, tx?: DbExecutor): Promise<TempFileRow | null> {
    const [row] = await this.client(tx)
      .update(temporaryFiles)
      .set({ claimedAt: new Date() })
      .where(
        and(
          eq(temporaryFiles.guuid, guuid),
          eq(temporaryFiles.uploadedBy, uploadedBy),
          isNull(temporaryFiles.claimedAt),
        ),
      )
      .returning();
    return row ?? null;
  }

  /** Release a claim so a failed commit can be retried before the temp expires. */
  async releaseTempClaim(id: string, tx?: DbExecutor): Promise<void> {
    await this.client(tx)
      .update(temporaryFiles)
      .set({ claimedAt: null })
      .where(eq(temporaryFiles.id, id));
  }

  /** Owner-scoped hard delete — used when a user cancels a staged upload before commit. */
  async deleteTempByGuuid(guuid: string, uploadedBy: string, tx?: DbExecutor): Promise<TempFileRow | null> {
    const [row] = await this.client(tx)
      .delete(temporaryFiles)
      .where(and(eq(temporaryFiles.guuid, guuid), eq(temporaryFiles.uploadedBy, uploadedBy)))
      .returning();
    return row ?? null;
  }

  /** Expired-and-uncommitted temps for the sweeper (Part C §C4). */
  async findExpiredTemps(now: Date, limit: number, tx?: DbExecutor): Promise<TempFileRow[]> {
    return this.client(tx)
      .select()
      .from(temporaryFiles)
      .where(lt(temporaryFiles.expiresAt, now))
      .limit(limit);
  }

  // ── Committed (files) ──────────────────────────────────────────────────

  async insertFile(row: NewFile, tx?: DbExecutor): Promise<FileRow> {
    const [inserted] = await this.client(tx).insert(files).values(row).returning();
    return inserted;
  }

  /** Active files attached to a record, store-scoped. */
  async findActiveByRecord(
    entityTypeFk: string,
    recordGuuid: string,
    storeId: string,
    tx?: DbExecutor,
  ): Promise<FileRow[]> {
    return this.client(tx)
      .select()
      .from(files)
      .where(
        and(
          eq(files.entityTypeFk, entityTypeFk),
          eq(files.recordGuuid, recordGuuid),
          eq(files.storeFk, storeId),
          isNull(files.deletedAt),
        ),
      );
  }

  /** Single active file, store-scoped (view / delete). */
  async findActiveByGuuid(guuid: string, storeId: string, tx?: DbExecutor): Promise<FileRow | null> {
    const [row] = await this.client(tx)
      .select()
      .from(files)
      .where(and(eq(files.guuid, guuid), eq(files.storeFk, storeId), isNull(files.deletedAt)));
    return row ?? null;
  }

  /** Single trashed file, store-scoped (restore). */
  async findTrashedByGuuid(guuid: string, storeId: string, tx?: DbExecutor): Promise<FileRow | null> {
    const [row] = await this.client(tx)
      .select()
      .from(files)
      .where(and(eq(files.guuid, guuid), eq(files.storeFk, storeId), isNotNull(files.deletedAt)));
    return row ?? null;
  }

  /** Count + total bytes of active files on a record — the commit-time consolidated/count checks. */
  async recordStats(
    entityTypeFk: string,
    recordGuuid: string,
    storeId: string,
    tx?: DbExecutor,
  ): Promise<{ count: number; totalBytes: number }> {
    const [row] = await this.client(tx)
      .select({
        count: sql<number>`count(*)::int`,
        totalBytes: sql<number>`coalesce(sum(${files.sizeBytes}), 0)::bigint`,
      })
      .from(files)
      .where(
        and(
          eq(files.entityTypeFk, entityTypeFk),
          eq(files.recordGuuid, recordGuuid),
          eq(files.storeFk, storeId),
          isNull(files.deletedAt),
        ),
      );
    return { count: Number(row?.count ?? 0), totalBytes: Number(row?.totalBytes ?? 0) };
  }

  async softDelete(guuid: string, storeId: string, deletedBy: string, tx?: DbExecutor): Promise<FileRow | null> {
    const [row] = await this.client(tx)
      .update(files)
      .set({ deletedAt: new Date(), deletedBy, updatedAt: new Date() })
      .where(and(eq(files.guuid, guuid), eq(files.storeFk, storeId), isNull(files.deletedAt)))
      .returning();
    return row ?? null;
  }

  async restore(guuid: string, storeId: string, updatedBy: string, tx?: DbExecutor): Promise<FileRow | null> {
    const [row] = await this.client(tx)
      .update(files)
      .set({ deletedAt: null, deletedBy: null, updatedBy, updatedAt: new Date() })
      .where(and(eq(files.guuid, guuid), eq(files.storeFk, storeId), isNotNull(files.deletedAt)))
      .returning();
    return row ?? null;
  }
}
