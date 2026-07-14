import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
} from 'drizzle-orm';

import {
  DRIZZLE,
  type Database,
  type DbExecutor,
  type DbTransaction,
} from '#db/db.module.js';
import { files, temporaryFiles } from '#db/schema.js';

export type TempFileRow = typeof temporaryFiles.$inferSelect;

export type FileRow = typeof files.$inferSelect;

export type NewTempFile = typeof temporaryFiles.$inferInsert;

export type NewFile = typeof files.$inferInsert;

export interface RecordFileStats {
  count: number;
  totalBytes: number;
}

/** Shared batch cap for record-guuid lists — also imported by
 *  `FilesService.listByRecords` and `ListFilesBatchQuerySchema` (the DTO
 *  layer) so the limit can't drift between the three enforcement points. */
export const MAX_BATCH_RECORDS = 100;
const MAX_SWEEP_BATCH = 1_000;

@Injectable()
export class FilesRepository {
  constructor(
    @Inject(DRIZZLE)
    private readonly db: Database,
  ) {}

  private client(tx?: DbExecutor): DbExecutor {
    return tx ?? this.db;
  }

  // ---------------------------------------------------------------------------
  // Temporary files
  // ---------------------------------------------------------------------------

  async insertTemp(row: NewTempFile, tx?: DbExecutor): Promise<TempFileRow> {
    const [inserted] = await this.client(tx)
      .insert(temporaryFiles)
      .values(row)
      .returning();

    if (!inserted) {
      throw new Error('Failed to insert temporary file');
    }

    return inserted;
  }

  /**
   * Owner-scoped temporary-file lookup.
   */
  async findTempByGuuid(
    guuid: string,
    uploadedBy: string,
    tx?: DbExecutor,
  ): Promise<TempFileRow | null> {
    const [row] = await this.client(tx)
      .select()
      .from(temporaryFiles)
      .where(
        and(
          eq(temporaryFiles.guuid, guuid),
          eq(temporaryFiles.uploadedBy, uploadedBy),
        ),
      )
      .limit(1);

    return row ?? null;
  }

  /**
   * Owner-scoped batch lookup.
   *
   * The service must map results by guuid if it needs to preserve the input
   * order.
   */
  async findTempsByGuuids(
    guuids: string[],
    uploadedBy: string,
    tx?: DbExecutor,
  ): Promise<TempFileRow[]> {
    const uniqueGuuids = normalizeUniqueValues(guuids);

    if (uniqueGuuids.length === 0) {
      return [];
    }

    return this.client(tx)
      .select()
      .from(temporaryFiles)
      .where(
        and(
          inArray(temporaryFiles.guuid, uniqueGuuids),
          eq(temporaryFiles.uploadedBy, uploadedBy),
        ),
      )
      .orderBy(asc(temporaryFiles.guuid));
  }

  /**
   * Atomically claims a non-expired temporary file.
   *
   * The expiry predicate is part of the UPDATE so a file cannot expire between
   * an earlier read and the claim operation.
   */
  async claimTemp(
    guuid: string,
    uploadedBy: string,
    now = new Date(),
    tx?: DbExecutor,
  ): Promise<TempFileRow | null> {
    const [claimed] = await this.client(tx)
      .update(temporaryFiles)
      .set({
        claimedAt: now,
      })
      .where(
        and(
          eq(temporaryFiles.guuid, guuid),
          eq(temporaryFiles.uploadedBy, uploadedBy),
          isNull(temporaryFiles.claimedAt),
          gt(temporaryFiles.expiresAt, now),
        ),
      )
      .returning();

    return claimed ?? null;
  }

  /**
   * Releases one specific claim.
   *
   * Matching uploadedBy preserves owner isolation. Matching claimedAt prevents
   * an old failure handler from clearing a newer claim.
   */
  async releaseTempClaim(
    id: string,
    uploadedBy: string,
    claimedAt: Date,
    tx?: DbExecutor,
  ): Promise<boolean> {
    const [released] = await this.client(tx)
      .update(temporaryFiles)
      .set({
        claimedAt: null,
      })
      .where(
        and(
          eq(temporaryFiles.id, id),
          eq(temporaryFiles.uploadedBy, uploadedBy),
          eq(temporaryFiles.claimedAt, claimedAt),
        ),
      )
      .returning({
        id: temporaryFiles.id,
      });

    return released !== undefined;
  }

  /**
   * Owner-scoped cancellation.
   *
   * An actively claimed row cannot be cancelled because its staged object may
   * currently be copied by commit().
   */
  async deleteTempByGuuid(
    guuid: string,
    uploadedBy: string,
    tx?: DbExecutor,
  ): Promise<TempFileRow | null> {
    const [deleted] = await this.client(tx)
      .delete(temporaryFiles)
      .where(
        and(
          eq(temporaryFiles.guuid, guuid),
          eq(temporaryFiles.uploadedBy, uploadedBy),
          isNull(temporaryFiles.claimedAt),
        ),
      )
      .returning();

    return deleted ?? null;
  }

  /**
   * Consumes a claimed temporary row during commit.
   *
   * This must run inside the same transaction as insertFile(). Matching all
   * claim fields prevents deleting a row belonging to a newer operation.
   */
  async deleteClaimedTempForCommit(
    id: string,
    uploadedBy: string,
    claimedAt: Date,
    tx: DbTransaction,
  ): Promise<TempFileRow | null> {
    const [deleted] = await tx
      .delete(temporaryFiles)
      .where(
        and(
          eq(temporaryFiles.id, id),
          eq(temporaryFiles.uploadedBy, uploadedBy),
          eq(temporaryFiles.claimedAt, claimedAt),
        ),
      )
      .returning();

    return deleted ?? null;
  }

  /**
   * Finds potential sweeper candidates.
   *
   * Selection does not authorize deletion. The sweeper must subsequently call
   * deleteExpiredTempIfReapable(), which atomically repeats these conditions.
   */
  async findExpiredTemps(
    now: Date,
    staleClaimBefore: Date,
    limit: number,
    tx?: DbExecutor,
  ): Promise<TempFileRow[]> {
    const safeLimit = normalizeLimit(limit, MAX_SWEEP_BATCH);

    if (safeLimit === 0) {
      return [];
    }

    return this.client(tx)
      .select()
      .from(temporaryFiles)
      .where(
        and(
          lt(temporaryFiles.expiresAt, now),
          or(
            isNull(temporaryFiles.claimedAt),
            lt(temporaryFiles.claimedAt, staleClaimBefore),
          ),
        ),
      )
      .orderBy(asc(temporaryFiles.expiresAt), asc(temporaryFiles.id))
      .limit(safeLimit);
  }

  /**
   * Race-safe sweeper deletion.
   *
   * A commit may claim a row after findExpiredTemps() selects it. Repeating the
   * expiry and stale-claim conditions in DELETE prevents the sweeper from
   * deleting a recently claimed row.
   *
   * The caller must delete the storage object only when this method returns a
   * row.
   */
  async deleteExpiredTempIfReapable(
    id: string,
    now: Date,
    staleClaimBefore: Date,
    tx?: DbExecutor,
  ): Promise<TempFileRow | null> {
    const [deleted] = await this.client(tx)
      .delete(temporaryFiles)
      .where(
        and(
          eq(temporaryFiles.id, id),
          lt(temporaryFiles.expiresAt, now),
          or(
            isNull(temporaryFiles.claimedAt),
            lt(temporaryFiles.claimedAt, staleClaimBefore),
          ),
        ),
      )
      .returning();

    return deleted ?? null;
  }

  /**
   * Serializes commits targeting one logical parent.
   *
   * This closes the per-record count and consolidated-size TOCTOU race.
   *
   * It must run inside the same transaction as:
   *
   * 1. recordStats()
   * 2. budget validation
   * 3. insertFile()
   * 4. deleteClaimedTempForCommit()
   */
  async lockRecordForCommit(
    tx: DbTransaction,
    storeId: string,
    entityTypeFk: string,
    recordGuuid: string,
  ): Promise<void> {
    const lockKey = [storeId, entityTypeFk, recordGuuid].join(':');

    await tx.execute(
      sql`
        select pg_advisory_xact_lock(
          hashtextextended(${lockKey}, 0)
        )
      `,
    );
  }

  // ---------------------------------------------------------------------------
  // Committed files
  // ---------------------------------------------------------------------------

  async insertFile(row: NewFile, tx?: DbExecutor): Promise<FileRow> {
    const [inserted] = await this.client(tx)
      .insert(files)
      .values(row)
      .returning();

    if (!inserted) {
      throw new Error('Failed to insert committed file');
    }

    return inserted;
  }

  /**
   * Active files for one parent, always store-scoped.
   */
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
      )
      .orderBy(asc(files.createdAt), asc(files.id));
  }

  /**
   * Active files for several parents, always store-scoped.
   */
  async findActiveByRecords(
    entityTypeFk: string,
    recordGuuids: string[],
    storeId: string,
    tx?: DbExecutor,
  ): Promise<FileRow[]> {
    const uniqueRecordGuuids = normalizeUniqueValues(recordGuuids);

    if (uniqueRecordGuuids.length === 0) {
      return [];
    }

    if (uniqueRecordGuuids.length > MAX_BATCH_RECORDS) {
      throw new RangeError(
        `A maximum of ${MAX_BATCH_RECORDS} record guuids is allowed`,
      );
    }

    return this.client(tx)
      .select()
      .from(files)
      .where(
        and(
          eq(files.entityTypeFk, entityTypeFk),
          inArray(files.recordGuuid, uniqueRecordGuuids),
          eq(files.storeFk, storeId),
          isNull(files.deletedAt),
        ),
      )
      .orderBy(asc(files.recordGuuid), asc(files.createdAt), asc(files.id));
  }

  /**
   * One active file, always store-scoped.
   */
  async findActiveByGuuid(
    guuid: string,
    storeId: string,
    tx?: DbExecutor,
  ): Promise<FileRow | null> {
    const [row] = await this.client(tx)
      .select()
      .from(files)
      .where(
        and(
          eq(files.guuid, guuid),
          eq(files.storeFk, storeId),
          isNull(files.deletedAt),
        ),
      )
      .limit(1);

    return row ?? null;
  }

  /**
   * One trashed file, always store-scoped.
   */
  async findTrashedByGuuid(
    guuid: string,
    storeId: string,
    tx?: DbExecutor,
  ): Promise<FileRow | null> {
    const [row] = await this.client(tx)
      .select()
      .from(files)
      .where(
        and(
          eq(files.guuid, guuid),
          eq(files.storeFk, storeId),
          isNotNull(files.deletedAt),
        ),
      )
      .limit(1);

    return row ?? null;
  }

  /**
   * Returns count and consolidated size for a parent's active files.
   *
   * When used for limit enforcement, call this only after
   * lockRecordForCommit() and inside the same transaction as the inserts.
   */
  async recordStats(
    entityTypeFk: string,
    recordGuuid: string,
    storeId: string,
    tx?: DbExecutor,
  ): Promise<RecordFileStats> {
    const [row] = await this.client(tx)
      .select({
        count: sql<number>`
          count(*)::integer
        `,
        totalBytes: sql<string>`
          coalesce(
            sum(${files.sizeBytes}),
            0
          )::bigint::text
        `,
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

    const count = Number(row?.count ?? 0);

    const totalBytes = Number(row?.totalBytes ?? 0);

    if (!Number.isSafeInteger(count) || count < 0) {
      throw new RangeError('Invalid attachment count returned by database');
    }

    if (!Number.isSafeInteger(totalBytes) || totalBytes < 0) {
      throw new RangeError(
        'Attachment byte total exceeds JavaScript safe-integer range',
      );
    }

    return {
      count,
      totalBytes,
    };
  }

  /**
   * Store-scoped soft deletion.
   */
  async softDelete(
    guuid: string,
    storeId: string,
    deletedBy: string,
    tx?: DbExecutor,
  ): Promise<FileRow | null> {
    const now = new Date();

    const [deleted] = await this.client(tx)
      .update(files)
      .set({
        deletedAt: now,
        deletedBy,
        updatedAt: now,
        updatedBy: deletedBy,
      })
      .where(
        and(
          eq(files.guuid, guuid),
          eq(files.storeFk, storeId),
          isNull(files.deletedAt),
        ),
      )
      .returning();

    return deleted ?? null;
  }

  /**
   * System-only soft deletion for the orphan reaper.
   *
   * The scheduled job has no request tenant context, so this method is
   * intentionally not store-scoped. Its input must come exclusively from the
   * trusted orphan query.
   */
  async systemSoftDeleteOrphan(
    guuid: string,
    tx?: DbExecutor,
  ): Promise<FileRow | null> {
    const now = new Date();

    const [deleted] = await this.client(tx)
      .update(files)
      .set({
        deletedAt: now,
        updatedAt: now,
      })
      .where(and(eq(files.guuid, guuid), isNull(files.deletedAt)))
      .returning();

    return deleted ?? null;
  }

  /**
   * Backward-compatible name used by the existing orphan reaper.
   */
  async reapOrphan(guuid: string, tx?: DbExecutor): Promise<void> {
    await this.systemSoftDeleteOrphan(guuid, tx);
  }

  /**
   * One active file matching a (entityTypeFk, recordGuuid, sha256) identity —
   * the same identity `uk_files_record_sha` enforces uniqueness over. Used by
   * the service to collapse a 23505 on that constraint (a duplicate insert or
   * restore racing/retrying into an existing live row) to the existing row
   * instead of erroring, matching the constraint's own dedupe intent.
   */
  async findActiveByRecordSha(
    entityTypeFk: string,
    recordGuuid: string,
    sha256: string,
    storeId: string,
    tx?: DbExecutor,
  ): Promise<FileRow | null> {
    const [row] = await this.client(tx)
      .select()
      .from(files)
      .where(
        and(
          eq(files.entityTypeFk, entityTypeFk),
          eq(files.recordGuuid, recordGuuid),
          eq(files.sha256, sha256),
          eq(files.storeFk, storeId),
          isNull(files.deletedAt),
        ),
      )
      .limit(1);

    return row ?? null;
  }

  /**
   * Restores one store-owned trashed file.
   *
   * A unique-index violation (`uk_files_record_sha`) can occur if identical
   * bytes were committed to the same record after the original file was
   * deleted. The service (`FilesService.restoreFile`) translates PostgreSQL
   * error 23505 on that constraint into collapsing to the existing live row.
   */
  async restore(
    guuid: string,
    storeId: string,
    updatedBy: string,
    tx?: DbExecutor,
  ): Promise<FileRow | null> {
    const [restored] = await this.client(tx)
      .update(files)
      .set({
        deletedAt: null,
        deletedBy: null,
        updatedBy,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(files.guuid, guuid),
          eq(files.storeFk, storeId),
          isNotNull(files.deletedAt),
        ),
      )
      .returning();

    return restored ?? null;
  }
}

function normalizeUniqueValues(values: string[]): string[] {
  const normalized = values.map((value) => value.trim());

  if (normalized.some((value) => value.length === 0)) {
    throw new TypeError('Identifiers must not be empty');
  }

  return [...new Set(normalized)];
}

function normalizeLimit(value: number, maximum: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }

  return Math.min(Math.trunc(value), maximum);
}
