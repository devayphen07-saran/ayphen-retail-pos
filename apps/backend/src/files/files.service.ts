import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';

import { AppConfigService } from '#config/app-config.service.js';
import { UnitOfWork, type DbTransaction } from '#db/db.module.js';
import { unwrapPgError } from '#db/rethrow-unique-violation.js';
import { RequestContextService } from '#common/request-context/request-context.service.js';
import { BadRequestError, ForbiddenError } from '#common/exceptions/app.exception.js';
import { ErrorCodes } from '#common/error-codes.js';

import { EntityTypesRepository } from '../entity-types/entity-types.repository.js';
import {
  FilesRepository,
  type FileRow,
  type TempFileRow,
} from './files.repository.js';
import {
  FilesConfigRepository,
  type FileConfigRule,
} from './files-config.repository.js';
import {
  FileValidationService,
  type IncomingFile,
} from './file-validation.service.js';
import {
  STORAGE_PROVIDER,
  type StorageProvider,
} from './storage/storage.provider.js';
import { RecordExistenceService } from './record-existence.service.js';
import { RbacService } from '#common/rbac/rbac.service.js';

import type { StagedUpload, FileView } from './types/file-views.js';

import {
  EntityDoesNotSupportAttachmentsError,
  FileConfigNotFoundError,
  FileNotFoundError,
  FileTooLargeError,
  ParentRecordNotFoundError,
  ParentVerificationUnavailableError,
  StorageUnavailableError,
  TempFileExpiredError,
  TempFileNotFoundError,
} from './files.errors.js';

export interface CommitFilesCommand {
  entityType: string;
  recordGuuid: string;
  recordId?: string | null;
  kind: string;
  fileGuuids: string[];
  description?: string | null;
}

interface ClaimedTemp {
  row: TempFileRow;
  claimedAt: Date;
}

interface CommitPlanItem {
  temp: TempFileRow;
  claimedAt: Date;
  committedKey: string;
}

interface ResolvedEntity {
  id: string;
  code: string;
}

@Injectable()
export class FilesService {
  private readonly log = new Logger(FilesService.name);

  constructor(
    private readonly config: AppConfigService,
    private readonly uow: UnitOfWork,
    private readonly ctx: RequestContextService,
    private readonly entityTypes: EntityTypesRepository,
    private readonly filesRepo: FilesRepository,
    private readonly configRepo: FilesConfigRepository,
    private readonly validation: FileValidationService,
    private readonly recordExistence: RecordExistenceService,
    private readonly rbac: RbacService,
    @Inject(STORAGE_PROVIDER)
    private readonly storage: StorageProvider,
  ) {}

  /**
   * Per-parent-entity authorization (D2): modifying a record's attachments
   * (stage/commit/delete/restore) requires the parent entity's `edit` CRUD in
   * this store — store membership alone is NOT enough (a read-only member must
   * not be able to change attachments). Fail-closed: an unknown/unregistered
   * entity code has no `edit` grant, so `checkCrud` denies it.
   */
  private async assertCanEditEntity(entityCode: string): Promise<void> {
    const userId = this.requireUserId();
    const storeId = this.requireStoreId();
    const permissions = await this.rbac.getCachedPermissions(userId, storeId, false);
    if (!this.rbac.checkCrud(permissions, entityCode, 'edit')) {
      throw new ForbiddenError(
        ErrorCodes.PERMISSION_DENIED,
        `You do not have permission to modify ${entityCode} attachments`,
      );
    }
  }

  /** Same check, resolving the entity code from a committed file's `entity_type_fk`. */
  private async assertCanEditEntityById(entityTypeFk: string): Promise<void> {
    const entity = await this.entityTypes.findById(entityTypeFk);
    if (!entity) {
      throw new ForbiddenError(
        ErrorCodes.PERMISSION_DENIED,
        'Unknown attachment parent entity',
      );
    }
    await this.assertCanEditEntity(entity.code);
  }

  // ---------------------------------------------------------------------------
  // Phase 1: stage
  // ---------------------------------------------------------------------------

  async stageUpload(
    file: IncomingFile,
    entityTypeCode: string,
    kind: string,
  ): Promise<StagedUpload> {
    const userId = this.requireUserId();

    // Global size ceiling (the per-rule limit is enforced by validateAtIngestion
    // below). The controller's multer `limits.fileSize` is the memory backstop at
    // ingress; this is the authoritative policy check against the live config.
    if (file.size > this.config.uploadMaxFileSizeBytes) {
      throw new FileTooLargeError(file.size, this.config.uploadMaxFileSizeBytes);
    }

    const { rule } = await this.resolveEntityAndRule(entityTypeCode, kind, {
      requireAttachments: true,
    });

    await this.assertCanEditEntity(entityTypeCode);

    this.validation.validateAtIngestion(file, rule);

    const now = Date.now();
    const sha256 = createHash('sha256').update(file.buffer).digest('hex');

    const storageKey = [
      'tmp',
      userId,
      randomUUID(),
      safeName(file.originalName),
    ].join('/');

    await this.putOrFail(storageKey, file.buffer, file.mimeType);

    let tempRow: TempFileRow;

    try {
      tempRow = await this.filesRepo.insertTemp({
        fileName: file.originalName.slice(0, 255),
        storageKey,
        sizeBytes: file.size,
        mimeType: file.mimeType,
        sha256,
        uploadedBy: userId,
        expiresAt: new Date(now + this.config.tempFileTtlHours * 3_600_000),
      });
    } catch (error) {
      await this.safeDelete(storageKey);
      throw error;
    }

    try {
      const previewUrl = await this.getSignedUrlOrFail(storageKey);

      return {
        guuid: tempRow.guuid,
        fileName: tempRow.fileName,
        sizeBytes: tempRow.sizeBytes,
        mimeType: tempRow.mimeType,
        sha256: tempRow.sha256,
        expiresAt: tempRow.expiresAt,
        previewUrl,
      };
    } catch (error) {
      /*
       * The staged object and database row are valid even if signing fails.
       * Do not delete the row here because the storage provider may have created
       * a usable object and the client may retry through a separate lookup.
       *
       * The temporary-file sweeper remains the eventual cleanup mechanism.
       */
      this.log.warn(
        `Staged temp ${tempRow.guuid}, but preview URL signing failed`,
      );

      throw error;
    }
  }

  async cancelStaged(guuid: string): Promise<void> {
    const userId = this.requireUserId();

    const row = await this.filesRepo.deleteTempByGuuid(guuid, userId);

    if (!row) {
      throw new TempFileNotFoundError({ guuid });
    }

    await this.safeDelete(row.storageKey);
  }

  // ---------------------------------------------------------------------------
  // Phase 2: commit
  // ---------------------------------------------------------------------------

  async commit(rawCommand: CommitFilesCommand): Promise<FileView[]> {
    const userId = this.requireUserId();
    const storeId = this.requireStoreId();
    const command = normalizeCommitCommand(rawCommand);

    const { entity, rule } = await this.resolveEntityAndRule(
      command.entityType,
      command.kind,
      { requireAttachments: true },
    );

    await this.assertCanEditEntity(entity.code);

    await this.assertParentExists(
      command.entityType,
      command.recordGuuid,
      storeId,
    );

    const resolvedTemps = await this.resolveTemps(command.fileGuuids, userId);

    /*
     * This pre-copy check is only an early rejection optimization.
     * The authoritative check occurs in persistFiles() while holding the
     * transaction-scoped parent advisory lock.
     */
    const preliminaryStats = await this.filesRepo.recordStats(
      entity.id,
      command.recordGuuid,
      storeId,
    );

    this.assertRecordBudget(resolvedTemps, preliminaryStats, rule);

    const claimedTemps = await this.claimAll(resolvedTemps, userId);

    const plan = this.buildCommitPlan(
      claimedTemps,
      storeId,
      entity.code,
      command.recordGuuid,
    );

    try {
      await this.copyStaged(plan);

      const inserted = await this.persistFiles(
        plan,
        command,
        entity,
        storeId,
        userId,
        rule,
      );

      /*
       * Database commit has succeeded. Temporary objects no longer represent
       * authoritative data, so cleanup is best-effort.
       */
      await Promise.allSettled(
        plan.map(({ temp }) => this.safeDelete(temp.storageKey)),
      );

      return await this.toFileViews(inserted);
    } catch (error) {
      /*
       * Committed-copy cleanup already happened by the time control reaches
       * here: copyStaged() deletes every target key itself on a partial-copy
       * failure (see its own doc comment), and persistFiles() deletes them in
       * its own catch on a transaction failure. Calling deleteCommittedCopies()
       * again here would just be a redundant (idempotent, but wasteful) no-op.
       */
      await this.releaseClaims(claimedTemps, userId);

      throw error;
    }
  }

  private async assertParentExists(
    entityTypeCode: string,
    recordGuuid: string,
    storeId: string,
  ): Promise<void> {
    if (!this.recordExistence.supports(entityTypeCode)) {
      throw new ParentVerificationUnavailableError(entityTypeCode);
    }

    const exists = await this.recordExistence.exists(
      entityTypeCode,
      recordGuuid,
      storeId,
    );

    if (!exists) {
      throw new ParentRecordNotFoundError(entityTypeCode, recordGuuid);
    }
  }

  private async resolveTemps(
    guuids: string[],
    userId: string,
  ): Promise<TempFileRow[]> {
    const uniqueGuuids = [...new Set(guuids)];

    if (uniqueGuuids.length !== guuids.length) {
      throw new TempFileNotFoundError({
        reason: 'duplicate_file_guuid',
      });
    }

    const found = await this.filesRepo.findTempsByGuuids(uniqueGuuids, userId);

    const byGuuid = new Map(found.map((temp) => [temp.guuid, temp]));

    const now = Date.now();

    return uniqueGuuids.map((guuid) => {
      const temp = byGuuid.get(guuid);

      if (!temp) {
        throw new TempFileNotFoundError({ guuid });
      }

      if (temp.claimedAt) {
        throw new TempFileNotFoundError({
          guuid,
          reason: 'already_claimed',
        });
      }

      if (temp.expiresAt.getTime() <= now) {
        throw new TempFileExpiredError({ guuid });
      }

      return temp;
    });
  }

  private assertRecordBudget(
    temps: TempFileRow[],
    stats: {
      count: number;
      totalBytes: number;
    },
    rule: FileConfigRule,
  ): void {
    let runningCount = stats.count;
    let runningBytes = stats.totalBytes;

    for (const temp of temps) {
      this.validation.validateAtCommit(
        { size: temp.sizeBytes, originalName: temp.fileName },
        rule,
        { count: runningCount, totalBytes: runningBytes },
      );

      runningCount += 1;
      runningBytes += temp.sizeBytes;
    }
  }

  private async claimAll(
    temps: TempFileRow[],
    userId: string,
  ): Promise<ClaimedTemp[]> {
    const claimedTemps: ClaimedTemp[] = [];

    try {
      for (const temp of temps) {
        const claimed = await this.filesRepo.claimTemp(
          temp.guuid,
          userId,
          new Date(),
        );

        if (!claimed || !claimed.claimedAt) {
          /*
           * claimTemp() also checks expires_at. Distinguish an observed expiry
           * from a generic lost claim when possible.
           */
          if (temp.expiresAt.getTime() <= Date.now()) {
            throw new TempFileExpiredError({
              guuid: temp.guuid,
            });
          }

          throw new TempFileNotFoundError({
            guuid: temp.guuid,
            reason: 'already_claimed_or_expired',
          });
        }

        claimedTemps.push({
          row: claimed,
          claimedAt: claimed.claimedAt,
        });
      }

      return claimedTemps;
    } catch (error) {
      await this.releaseClaims(claimedTemps, userId);

      throw error;
    }
  }

  private buildCommitPlan(
    claimedTemps: ClaimedTemp[],
    storeId: string,
    entityCode: string,
    recordGuuid: string,
  ): CommitPlanItem[] {
    return claimedTemps.map(({ row, claimedAt }) => ({
      temp: row,
      claimedAt,
      committedKey: [
        storeId,
        safePathSegment(entityCode),
        safePathSegment(recordGuuid),
        randomUUID(),
        safeName(row.fileName),
      ].join('/'),
    }));
  }

  /**
   * Copies every staged object and waits for all copy attempts to settle.
   *
   * Promise.all() is unsafe here: it rejects as soon as one copy fails while
   * other copies continue running. Cleanup can then execute before a late copy
   * lands, leaving an orphaned committed object.
   */
  private async copyStaged(plan: CommitPlanItem[]): Promise<void> {
    const results = await Promise.allSettled(
      plan.map(({ temp, committedKey }) =>
        this.storage.copyObject(temp.storageKey, committedKey),
      ),
    );

    const failed = results.some((result) => result.status === 'rejected');

    if (!failed) {
      return;
    }

    /*
     * Delete every target key, not only fulfilled copies. Some providers can
     * complete a copy even when the client observes a timeout or rejection.
     * Object deletion must therefore be idempotent.
     */
    await this.deleteCommittedCopies(plan);

    const firstFailure = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );

    if (firstFailure?.reason instanceof StorageUnavailableError) {
      throw firstFailure.reason;
    }

    this.log.error(
      'One or more staged-object copies failed',
      errorStack(firstFailure?.reason),
    );

    throw new StorageUnavailableError();
  }

  private async persistFiles(
    plan: CommitPlanItem[],
    command: CommitFilesCommand,
    entity: ResolvedEntity,
    storeId: string,
    userId: string,
    rule: FileConfigRule,
  ): Promise<FileRow[]> {
    try {
      return await this.uow.execute(async (tx) => {
        /*
         * The advisory lock, budget query and inserts must use this same
         * transaction. Including entity.id prevents polymorphic parents with
         * the same guuid from sharing the wrong lock domain.
         */
        await this.filesRepo.lockRecordForCommit(
          tx,
          storeId,
          entity.id,
          command.recordGuuid,
        );

        /*
         * Recheck the parent after obtaining the serialization lock. This
         * reduces the parent-deletion race. Full prevention requires the parent
         * row to be locked in this same transaction by RecordExistenceService.
         */
        const parentStillExists = await this.recordExistence.exists(
          command.entityType,
          command.recordGuuid,
          storeId,
        );

        if (!parentStillExists) {
          throw new ParentRecordNotFoundError(
            command.entityType,
            command.recordGuuid,
          );
        }

        const stats = await this.filesRepo.recordStats(
          entity.id,
          command.recordGuuid,
          storeId,
          tx,
        );

        this.assertRecordBudget(
          plan.map(({ temp }) => temp),
          stats,
          rule,
        );

        const insertedRows: FileRow[] = [];

        for (const item of plan) {
          const inserted = await this.insertFileOrCollapseToExisting(
            tx,
            entity,
            storeId,
            command,
            item,
            userId,
          );

          const consumedTemp = await this.filesRepo.deleteClaimedTempForCommit(
            item.temp.id,
            userId,
            item.claimedAt,
            tx,
          );

          if (!consumedTemp) {
            throw new TempFileNotFoundError({
              guuid: item.temp.guuid,
              reason: 'claimed_temp_disappeared_during_commit',
            });
          }

          insertedRows.push(inserted);
        }

        return insertedRows;
      });
    } catch (error) {
      await this.deleteCommittedCopies(plan);
      throw error;
    }
  }

  /**
   * Insert one committed file row, collapsing a `uk_files_record_sha`
   * violation to the existing live row instead of erroring (P1: a retried or
   * doubly-tapped commit of the same bytes onto the same record is an
   * idempotent success, matching the constraint's own dedupe intent — see
   * `FilesRepository.restore`'s doc comment).
   *
   * Wrapped in a SAVEPOINT: `tx` is the shared commit transaction (also used
   * for the advisory lock, budget check, and every other item's insert in
   * this loop) — without a SAVEPOINT, Postgres aborts the whole transaction
   * on the first error, and every subsequent statement on this same `tx`
   * (including this method's own recovery lookup, and any later items in
   * `plan`) would fail with "current transaction is aborted". SAVEPOINT /
   * ROLLBACK TO scopes the abort to just this one insert, so the rest of a
   * multi-file batch can still succeed.
   */
  private async insertFileOrCollapseToExisting(
    tx: DbTransaction,
    entity: ResolvedEntity,
    storeId: string,
    command: CommitFilesCommand,
    item: CommitPlanItem,
    userId: string,
  ): Promise<FileRow> {
    await tx.execute(sql`SAVEPOINT insert_file`);

    try {
      const inserted = await this.filesRepo.insertFile(
        {
          entityTypeFk: entity.id,
          recordId: command.recordId ?? null,
          recordGuuid: command.recordGuuid,
          storeFk: storeId,
          kind: command.kind,
          storageKey: item.committedKey,
          mimeType: item.temp.mimeType,
          sizeBytes: item.temp.sizeBytes,
          sha256: item.temp.sha256,
          originalFilename: item.temp.fileName,
          description: command.description ?? null,
          createdBy: userId,
          updatedBy: userId,
        },
        tx,
      );

      await tx.execute(sql`RELEASE SAVEPOINT insert_file`);

      return inserted;
    } catch (error) {
      const pgErr = unwrapPgError(error);

      if (pgErr?.code !== '23505' || pgErr.constraint_name !== 'uk_files_record_sha' || !item.temp.sha256) {
        throw error;
      }

      await tx.execute(sql`ROLLBACK TO SAVEPOINT insert_file`);
      await tx.execute(sql`RELEASE SAVEPOINT insert_file`);

      const existing = await this.filesRepo.findActiveByRecordSha(
        entity.id,
        command.recordGuuid,
        item.temp.sha256,
        storeId,
        tx,
      );

      if (!existing) {
        // Shouldn't happen — the violation implies a live conflicting row —
        // but fail closed rather than silently drop the file if it does.
        throw error;
      }

      // `copyStaged` already copied the staged bytes to `item.committedKey`
      // before this insert ran; collapsing to `existing` means that copy is
      // now unreferenced by any row, so it must be cleaned up here too (same
      // as the failure path's deleteCommittedCopies) or it leaks forever.
      await this.safeDelete(item.committedKey);

      return existing;
    }
  }

  private async deleteCommittedCopies(plan: CommitPlanItem[]): Promise<void> {
    await Promise.allSettled(
      plan.map(({ committedKey }) => this.safeDelete(committedKey)),
    );
  }

  private async releaseClaims(
    claimedTemps: ClaimedTemp[],
    userId: string,
  ): Promise<void> {
    const results = await Promise.allSettled(
      claimedTemps.map(({ row, claimedAt }) =>
        this.filesRepo.releaseTempClaim(row.id, userId, claimedAt),
      ),
    );

    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        return;
      }

      const temp = claimedTemps[index];

      this.log.warn(
        `Failed to release temp claim ${temp?.row.id ?? 'unknown'}: ${errorMessage(
          result.reason,
        )}`,
      );
    });
  }

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  async listByRecord(
    entityTypeCode: string,
    recordGuuid: string,
  ): Promise<FileView[]> {
    const storeId = this.requireStoreId();

    const entity = await this.entityTypes.findByCode(entityTypeCode);

    if (!entity) {
      throw new FileNotFoundError({
        entityType: entityTypeCode,
      });
    }

    const rows = await this.filesRepo.findActiveByRecord(
      entity.id,
      recordGuuid,
      storeId,
    );

    return this.toFileViews(rows);
  }

  async listByRecords(
    entityTypeCode: string,
    recordGuuids: string[],
  ): Promise<Record<string, FileView[]>> {
    const storeId = this.requireStoreId();
    const uniqueRecordGuuids = [...new Set(recordGuuids)];

    if (uniqueRecordGuuids.length > 100) {
      throw new BadRequestError(
        ErrorCodes.VALIDATION_FAILED,
        'A maximum of 100 record guuids is allowed',
      );
    }

    const entity = await this.entityTypes.findByCode(entityTypeCode);

    if (!entity) {
      throw new FileNotFoundError({
        entityType: entityTypeCode,
      });
    }

    const grouped: Record<string, FileView[]> = Object.fromEntries(
      uniqueRecordGuuids.map((guuid) => [guuid, []]),
    );

    if (uniqueRecordGuuids.length === 0) {
      return grouped;
    }

    const rows = await this.filesRepo.findActiveByRecords(
      entity.id,
      uniqueRecordGuuids,
      storeId,
    );

    // Build each view alongside its row so grouping is 1:1 by construction — no
    // index-alignment invariant to guard.
    const viewsByRow = await Promise.all(
      rows.map(async (row) => ({ recordGuuid: row.recordGuuid, view: await this.toFileView(row) })),
    );
    for (const { recordGuuid, view } of viewsByRow) {
      (grouped[recordGuuid] ??= []).push(view);
    }

    return grouped;
  }

  async getFile(guuid: string): Promise<FileView> {
    const storeId = this.requireStoreId();

    const row = await this.filesRepo.findActiveByGuuid(guuid, storeId);

    if (!row) {
      throw new FileNotFoundError({ guuid });
    }

    return this.toFileView(row);
  }

  // ---------------------------------------------------------------------------
  // Delete and restore
  // ---------------------------------------------------------------------------

  async deleteFile(guuid: string): Promise<void> {
    const userId = this.requireUserId();
    const storeId = this.requireStoreId();

    // D2: resolve the file first so we can authorize against its parent entity's
    // `edit` grant before mutating (store membership alone is not enough).
    const existing = await this.filesRepo.findActiveByGuuid(guuid, storeId);

    if (!existing) {
      throw new FileNotFoundError({ guuid });
    }

    await this.assertCanEditEntityById(existing.entityTypeFk);

    const row = await this.filesRepo.softDelete(guuid, storeId, userId);

    if (!row) {
      throw new FileNotFoundError({ guuid });
    }
  }

  async restoreFile(guuid: string): Promise<FileView> {
    const userId = this.requireUserId();
    const storeId = this.requireStoreId();

    // D2: authorize against the trashed file's parent entity before restoring.
    const existing = await this.filesRepo.findTrashedByGuuid(guuid, storeId);

    if (!existing) {
      throw new FileNotFoundError({ guuid });
    }

    await this.assertCanEditEntityById(existing.entityTypeFk);

    let row: FileRow | null;

    try {
      row = await this.filesRepo.restore(guuid, storeId, userId);
    } catch (error) {
      const pgErr = unwrapPgError(error);

      // uk_files_record_sha: identical bytes were committed to this record
      // after `guuid` was deleted. Per FilesRepository.restore's doc comment,
      // collapse to the existing live row instead of erroring — the trashed
      // row being restored is a stale duplicate of bytes already live.
      if (pgErr?.code !== '23505' || pgErr.constraint_name !== 'uk_files_record_sha' || !existing.sha256) {
        throw error;
      }

      row = await this.filesRepo.findActiveByRecordSha(
        existing.entityTypeFk,
        existing.recordGuuid,
        existing.sha256,
        storeId,
      );
    }

    if (!row) {
      throw new FileNotFoundError({ guuid });
    }

    return this.toFileView(row);
  }

  // ---------------------------------------------------------------------------
  // Temporary-file sweeper
  // ---------------------------------------------------------------------------

  async sweepExpiredTemps(batch = 500): Promise<number> {
    const now = new Date();
    const staleClaimBefore = new Date(
      now.getTime() - this.config.tempFileClaimGraceMs,
    );

    const candidates = await this.filesRepo.findExpiredTemps(
      now,
      staleClaimBefore,
      batch,
    );

    let removed = 0;

    for (const candidate of candidates) {
      /*
       * Delete the database row conditionally before deleting the object.
       *
       * The DELETE repeats the expiry/claim predicates atomically. If a commit
       * claimed the row after candidate selection, this returns null and the
       * sweeper leaves its object untouched.
       */
      const deleted = await this.filesRepo.deleteExpiredTempIfReapable(
        candidate.id,
        now,
        staleClaimBefore,
      );

      if (!deleted) {
        continue;
      }

      /*
       * A failed object deletion leaves an unreferenced storage object, which is
       * safer than deleting bytes used by a commit. Production deployments
       * should also run an object-store inventory reconciliation job.
       */
      await this.safeDelete(deleted.storageKey);
      removed += 1;
    }

    if (removed > 0) {
      this.log.log(`Swept ${removed} expired temporary file(s)`);
    }

    return removed;
  }

  // ---------------------------------------------------------------------------
  // Shared helpers
  // ---------------------------------------------------------------------------

  private async resolveEntityAndRule(
    entityTypeCode: string,
    kind: string,
    options: {
      requireAttachments: boolean;
    },
  ): Promise<{
    entity: ResolvedEntity;
    rule: FileConfigRule;
  }> {
    const entity = await this.entityTypes.findByCode(entityTypeCode);

    if (!entity) {
      throw new FileConfigNotFoundError(entityTypeCode, kind);
    }

    if (options.requireAttachments && !entity.supportsAttachments) {
      throw new EntityDoesNotSupportAttachmentsError(entityTypeCode);
    }

    const rule = await this.configRepo.findRule(entity.id, kind);

    if (!rule) {
      throw new FileConfigNotFoundError(entityTypeCode, kind);
    }

    return {
      entity: {
        id: entity.id,
        code: entity.code,
      },
      rule,
    };
  }

  private async toFileViews(rows: FileRow[]): Promise<FileView[]> {
    return Promise.all(rows.map((row) => this.toFileView(row)));
  }

  /**
   * Build the camelCase domain view for a committed file: attach a fresh signed
   * URL and drop the secret `storageKey`/`storageUrl` columns. The controller
   * maps this to the wire DTO via `FilesMapper`.
   */
  private async toFileView(row: FileRow): Promise<FileView> {
    const url = await this.getSignedUrlOrFail(row.storageKey);
    return {
      guuid: row.guuid,
      kind: row.kind,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
      originalFilename: row.originalFilename,
      description: row.description,
      url,
      thumbnailUrl: row.thumbnailUrl,
      createdAt: row.createdAt,
    };
  }

  private async getSignedUrlOrFail(key: string): Promise<string> {
    try {
      return await this.storage.getSignedUrl(
        key,
        this.config.storageSignedUrlTtlSeconds,
      );
    } catch (error) {
      if (error instanceof StorageUnavailableError) {
        throw error;
      }

      this.log.error(`Object URL signing failed for ${key}`, errorStack(error));

      throw new StorageUnavailableError();
    }
  }

  private async putOrFail(
    key: string,
    body: Buffer,
    contentType: string,
  ): Promise<void> {
    try {
      await this.storage.putObject(key, body, contentType);
    } catch (error) {
      if (error instanceof StorageUnavailableError) {
        throw error;
      }

      this.log.error(`Object-store write failed for ${key}`, errorStack(error));

      throw new StorageUnavailableError();
    }
  }

  private async safeDelete(key: string): Promise<void> {
    try {
      await this.storage.deleteObject(key);
    } catch (error) {
      this.log.warn(
        `Best-effort object deletion failed for ${key}: ${errorMessage(error)}`,
      );
    }
  }

  private requireUserId(): string {
    const userId = this.ctx.getUserId();

    if (!userId) {
      throw new ForbiddenError(
        ErrorCodes.FORBIDDEN,
        'No authenticated user in context',
      );
    }

    return userId;
  }

  private requireStoreId(): string {
    const storeId = this.ctx.getStoreId();

    if (!storeId) {
      throw new ForbiddenError(
        ErrorCodes.FORBIDDEN,
        'A store context is required for this operation',
      );
    }

    return storeId;
  }
}

function normalizeCommitCommand(
  command: CommitFilesCommand,
): CommitFilesCommand {
  const entityType = command.entityType.trim();
  const recordGuuid = command.recordGuuid.trim();
  const kind = command.kind.trim();
  const fileGuuids = command.fileGuuids.map((guuid) => guuid.trim());

  if (!entityType) {
    throw new TypeError('entityType must not be empty');
  }

  if (!recordGuuid) {
    throw new TypeError('recordGuuid must not be empty');
  }

  if (!kind) {
    throw new TypeError('kind must not be empty');
  }

  if (fileGuuids.length === 0 || fileGuuids.some((guuid) => !guuid)) {
    throw new TypeError('At least one valid file guuid is required');
  }

  return {
    ...command,
    entityType,
    recordGuuid,
    kind,
    fileGuuids,
    description: command.description?.trim() || null,
  };
}

function safeName(name: string): string {
  const baseName = name.split(/[/\\]/).pop() || 'file';

  const cleaned = baseName
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 200);

  return cleaned || 'file';
}

function safePathSegment(value: string): string {
  const cleaned = value
    .normalize('NFKC')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_{2,}/g, '_')
    .slice(0, 200);

  if (!cleaned) {
    throw new TypeError('Invalid storage-key path segment');
  }

  return cleaned;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorStack(error: unknown): string | undefined {
  return error instanceof Error ? error.stack : undefined;
}
