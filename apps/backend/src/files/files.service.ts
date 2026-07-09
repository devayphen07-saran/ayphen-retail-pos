import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { AppConfigService } from '#config/app-config.service.js';
import { UnitOfWork } from '#db/db.module.js';
import { RequestContextService } from '#common/request-context/request-context.service.js';
import { EntityTypesRepository } from '../entity-types/entity-types.repository.js';
import { FilesRepository, type FileRow, type TempFileRow } from './files.repository.js';
import { FilesConfigRepository, type FileConfigRule } from './files-config.repository.js';
import { FileValidationService, type IncomingFile } from './file-validation.service.js';
import { STORAGE_PROVIDER, type StorageProvider } from './storage/storage.provider.js';
import { FilesMapper } from './files.mapper.js';
import type { TempUploadResponse } from './dto/temp-upload.response.js';
import type { FileResponse } from './dto/file.response.js';
import {
  EntityDoesNotSupportAttachmentsError,
  FileConfigNotFoundError,
  FileNotFoundError,
  StorageUnavailableError,
  TempFileExpiredError,
  TempFileNotFoundError,
} from './files.errors.js';
import { ForbiddenError } from '#common/exceptions/app.exception.js';
import { ErrorCodes } from '#common/error-codes.js';

/**
 * Two-phase upload orchestration (table-architecture §33, hardened to Part C).
 *
 * Invariants enforced here:
 *  - validation runs at ingestion, not deferred to commit (Part C P0-2);
 *  - staged temps are owner-scoped, committed files are store-scoped — no
 *    lookup by key/guuid alone (Part C P0-4);
 *  - S3 and DB never disagree permanently: commit copies staged→committed,
 *    inserts rows in one DB transaction, and only then deletes the staged
 *    object; a failed transaction deletes the copy so no `files` row is ever
 *    left pointing at a missing object (Part C P1-7).
 */
/** camelCase command consumed by `commit()` — produced by CommitFilesRequestMapper. */
export interface CommitFilesCommand {
  entityType:  string;
  recordGuuid: string;
  recordId?:   string | null;
  kind:        string;
  fileGuuids:  string[];
  description?: string | null;
}

/** A resolved staged temp paired with the committed storage key it copies to. */
type CommitPlanItem = { temp: TempFileRow; committedKey: string };

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
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
  ) {}

  // ── Phase 1: stage an upload (owner-scoped, validated at ingestion) ──────

  async stageUpload(file: IncomingFile, entityTypeCode: string, kind: string): Promise<TempUploadResponse> {
    const userId = this.requireUserId();
    const { rule } = await this.resolveEntityAndRule(entityTypeCode, kind, { requireAttachments: true });

    // Real gate — extension, size, magic-byte content sniff (Part C §C5).
    this.validation.validateAtIngestion(file, rule);

    const sha256 = createHash('sha256').update(file.buffer).digest('hex');
    const storageKey = `tmp/${userId}/${randomUUID()}/${safeName(file.originalName)}`;

    await this.putOrFail(storageKey, file.buffer, file.mimeType);

    let tempRow;
    try {
      tempRow = await this.filesRepo.insertTemp({
        fileName:   file.originalName.slice(0, 255),
        storageKey,
        sizeBytes:  file.size,
        mimeType:   file.mimeType,
        sha256,
        uploadedBy: userId,
        expiresAt:  new Date(Date.now() + this.config.tempFileTtlHours * 3_600_000),
      });
    } catch (err) {
      // DB insert failed after the object landed — clean it up now so we don't
      // rely solely on the sweeper (best-effort).
      await this.safeDelete(storageKey);
      throw err;
    }

    const previewUrl = await this.storage.getSignedUrl(storageKey, this.config.storageSignedUrlTtlSeconds);
    return FilesMapper.toTempResponse(tempRow, previewUrl);
  }

  /** Cancel a staged upload before it is committed (the "delete in-progress upload" the old app lacked). */
  async cancelStaged(guuid: string): Promise<void> {
    const userId = this.requireUserId();
    const row = await this.filesRepo.deleteTempByGuuid(guuid, userId);
    if (!row) throw new TempFileNotFoundError({ guuid });
    await this.safeDelete(row.storageKey);
  }

  // ── Phase 2: commit staged temps into permanent, record-linked files ─────

  async commit(cmd: CommitFilesCommand): Promise<FileResponse[]> {
    const userId = this.requireUserId();
    const storeId = this.requireStoreId();
    const { entity, rule } = await this.resolveEntityAndRule(cmd.entityType, cmd.kind, {
      requireAttachments: true,
    });

    const temps = await this.resolveTemps(cmd.fileGuuids, userId);
    this.assertRecordBudget(temps, await this.filesRepo.recordStats(entity.id, cmd.recordGuuid, storeId), rule);
    const claimedIds = await this.claimAll(temps, userId);

    try {
      const plan: CommitPlanItem[] = temps.map((temp) => ({
        temp,
        committedKey: `${storeId}/${entity.code}/${cmd.recordGuuid}/${randomUUID()}/${safeName(temp.fileName)}`,
      }));
      await this.copyStaged(plan);
      const inserted = await this.persistFiles(plan, cmd, entity.id, storeId, userId);

      // Post-commit cleanup of the staged objects — best-effort; the sweeper
      // reaps any that survive.
      await Promise.all(plan.map((p) => this.safeDelete(p.temp.storageKey)));

      return this.toResponses(inserted);
    } catch (err) {
      // Commit failed after claiming but before the temps were deleted (the
      // delete only happens inside persistFiles' atomic tx) — release the claims
      // so the caller can retry before the TTL.
      await this.releaseClaims(claimedIds);
      throw err;
    }
  }

  /** Resolve every requested guuid to a still-valid, owner-scoped staged temp,
   *  preserving request order. One batched query; per-guuid errors are kept so
   *  the client learns exactly which temp was missing or expired. No claim yet —
   *  validation runs first so a rejected commit never strands a claimed row. */
  private async resolveTemps(guuids: string[], userId: string): Promise<TempFileRow[]> {
    const found = await this.filesRepo.findTempsByGuuids(guuids, userId);
    const byGuuid = new Map(found.map((t) => [t.guuid, t]));
    const now = Date.now();
    return guuids.map((guuid) => {
      const temp = byGuuid.get(guuid);
      if (!temp) throw new TempFileNotFoundError({ guuid });
      if (temp.expiresAt.getTime() < now) throw new TempFileExpiredError({ guuid });
      return temp;
    });
  }

  /** Record-scoped budget checks (count + consolidated size), applied
   *  cumulatively over the batch on top of what the record already holds. */
  private assertRecordBudget(
    temps: TempFileRow[],
    stats: { count: number; totalBytes: number },
    rule: FileConfigRule,
  ): void {
    let runningCount = stats.count;
    let runningBytes = stats.totalBytes;
    for (const temp of temps) {
      this.validation.validateAtCommit({ size: temp.sizeBytes }, rule, {
        count: runningCount,
        totalBytes: runningBytes,
      });
      runningCount += 1;
      runningBytes += temp.sizeBytes;
    }
  }

  /** Atomic commit gate (schema §33 `claimed_at`): claim each temp before the
   *  slow copy+transaction. A concurrent commit of the same upload loses the
   *  race here and aborts, so one staged file can never become two `files` rows.
   *  Returns the claimed ids so any later failure can release them for a retry;
   *  releases already-won claims itself if a claim mid-batch loses the race. */
  private async claimAll(temps: TempFileRow[], userId: string): Promise<string[]> {
    const claimedIds: string[] = [];
    for (const temp of temps) {
      const claimed = await this.filesRepo.claimTemp(temp.guuid, userId);
      if (!claimed) {
        await this.releaseClaims(claimedIds);
        throw new TempFileNotFoundError({ guuid: temp.guuid, reason: 'already_committed' });
      }
      claimedIds.push(temp.id);
    }
    return claimedIds;
  }

  /** Copy staged → committed objects (no temp delete yet). Runs the copies
   *  concurrently (the batch is capped per request); on any failure, deletes the
   *  copies that did land so no orphaned committed object is left behind. */
  private async copyStaged(plan: CommitPlanItem[]): Promise<void> {
    const copied: string[] = [];
    try {
      await Promise.all(
        plan.map(async (p) => {
          await this.storage.copyObject(p.temp.storageKey, p.committedKey);
          copied.push(p.committedKey);
        }),
      );
    } catch (err) {
      await Promise.all(copied.map((k) => this.safeDelete(k)));
      throw err instanceof StorageUnavailableError ? err : new StorageUnavailableError();
    }
  }

  /** One DB transaction: insert every `files` row and delete its temp row, so a
   *  staged upload becomes exactly one committed file or none. If the tx throws,
   *  roll back and delete the staged→committed copies — no dangling references.
   *  The insert loop stays sequential: it shares the single tx connection. */
  private async persistFiles(
    plan: CommitPlanItem[],
    cmd: CommitFilesCommand,
    entityId: string,
    storeId: string,
    userId: string,
  ): Promise<FileRow[]> {
    try {
      return await this.uow.execute(async (tx) => {
        const rows: FileRow[] = [];
        for (const p of plan) {
          const row = await this.filesRepo.insertFile(
            {
              entityTypeFk:     entityId,
              recordId:         cmd.recordId ?? null,
              recordGuuid:      cmd.recordGuuid,
              storeFk:          storeId,
              kind:             cmd.kind,
              storageKey:       p.committedKey,
              mimeType:         p.temp.mimeType,
              sizeBytes:        p.temp.sizeBytes,
              sha256:           p.temp.sha256,
              originalFilename: p.temp.fileName,
              description:      cmd.description ?? null,
              createdBy:        userId,
              updatedBy:        userId,
            },
            tx,
          );
          rows.push(row);
          await this.filesRepo.deleteTempById(p.temp.id, tx);
        }
        return rows;
      });
    } catch (err) {
      await Promise.all(plan.map((p) => this.safeDelete(p.committedKey)));
      throw err;
    }
  }

  // ── Retrieve / delete / restore (store-scoped) ───────────────────────────

  async listByRecord(entityTypeCode: string, recordGuuid: string): Promise<FileResponse[]> {
    const storeId = this.requireStoreId();
    const entity = await this.entityTypes.findByCode(entityTypeCode);
    if (!entity) throw new FileNotFoundError({ entityType: entityTypeCode });
    const rows = await this.filesRepo.findActiveByRecord(entity.id, recordGuuid, storeId);
    return this.toResponses(rows);
  }

  async getFile(guuid: string): Promise<FileResponse> {
    const storeId = this.requireStoreId();
    const row = await this.filesRepo.findActiveByGuuid(guuid, storeId);
    if (!row) throw new FileNotFoundError({ guuid });
    return (await this.toResponses([row]))[0];
  }

  async deleteFile(guuid: string): Promise<void> {
    const userId = this.requireUserId();
    const storeId = this.requireStoreId();
    const row = await this.filesRepo.softDelete(guuid, storeId, userId);
    if (!row) throw new FileNotFoundError({ guuid });
  }

  async restoreFile(guuid: string): Promise<FileResponse> {
    const userId = this.requireUserId();
    const storeId = this.requireStoreId();
    const row = await this.filesRepo.restore(guuid, storeId, userId);
    if (!row) throw new FileNotFoundError({ guuid });
    return (await this.toResponses([row]))[0];
  }

  // ── Sweeper hook (called by the cron) ────────────────────────────────────

  /** Reap expired, uncommitted temp rows and their objects. Returns the count removed. */
  async sweepExpiredTemps(batch = 500): Promise<number> {
    const expired = await this.filesRepo.findExpiredTemps(new Date(), batch);
    let removed = 0;
    for (const temp of expired) {
      await this.safeDelete(temp.storageKey);
      await this.filesRepo.deleteTempById(temp.id);
      removed += 1;
    }
    if (removed > 0) this.log.log(`Swept ${removed} expired temp file(s).`);
    return removed;
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private async resolveEntityAndRule(
    entityTypeCode: string,
    kind: string,
    opts: { requireAttachments: boolean },
  ): Promise<{ entity: { id: string; code: string }; rule: FileConfigRule }> {
    const entity = await this.entityTypes.findByCode(entityTypeCode);
    if (!entity) throw new FileConfigNotFoundError(entityTypeCode, kind);
    if (opts.requireAttachments && !entity.supportsAttachments) {
      throw new EntityDoesNotSupportAttachmentsError(entityTypeCode);
    }
    const rule = await this.configRepo.findRule(entity.id, kind);
    if (!rule) throw new FileConfigNotFoundError(entityTypeCode, kind);
    return { entity, rule };
  }

  private async toResponses(rows: FileRow[]): Promise<FileResponse[]> {
    return Promise.all(
      rows.map(async (row) =>
        FilesMapper.toFileResponse(
          row,
          await this.storage.getSignedUrl(row.storageKey, this.config.storageSignedUrlTtlSeconds),
        ),
      ),
    );
  }

  private async putOrFail(key: string, body: Buffer, contentType: string): Promise<void> {
    try {
      await this.storage.putObject(key, body, contentType);
    } catch (err) {
      if (err instanceof StorageUnavailableError) throw err;
      this.log.error(`Object store write failed for ${key}`, err instanceof Error ? err.stack : undefined);
      throw new StorageUnavailableError();
    }
  }

  /** Best-effort release of commit claims so a failed commit can be retried. */
  private async releaseClaims(ids: string[]): Promise<void> {
    await Promise.all(
      ids.map((id) =>
        this.filesRepo.releaseTempClaim(id).catch((err) =>
          this.log.warn(`Failed to release claim on temp ${id}: ${err instanceof Error ? err.message : String(err)}`),
        ),
      ),
    );
  }

  private async safeDelete(key: string): Promise<void> {
    try {
      await this.storage.deleteObject(key);
    } catch (err) {
      // Never let cleanup failure surface as a request error — the sweeper /
      // orphan audit is the backstop.
      this.log.warn(`Best-effort delete failed for ${key}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private requireUserId(): string {
    const id = this.ctx.getUserId();
    if (!id) throw new ForbiddenError(ErrorCodes.FORBIDDEN, 'No authenticated user in context');
    return id;
  }

  private requireStoreId(): string {
    const id = this.ctx.getStoreId();
    if (!id) throw new ForbiddenError(ErrorCodes.FORBIDDEN, 'A store context is required for this operation');
    return id;
  }
}

/** Strip anything unsafe from a client filename before it becomes part of a storage key. */
function safeName(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? 'file';
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/_{2,}/g, '_');
  return cleaned.slice(0, 200) || 'file';
}
