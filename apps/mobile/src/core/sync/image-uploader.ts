import NetInfo from '@react-native-community/netinfo';
import * as FileSystem from 'expo-file-system/legacy';
import {
  STAGE_FILE,
  COMMIT_FILES,
  type TempUploadResponse,
  type FileResponse,
  type CommitFilesRequest,
  type NormalizedError,
  type UploadParams,
  type RequestParams,
} from '@ayphen/api-manager';
import { getSyncDb } from './db/client';
import {
  attachmentRepository,
  type AttachmentRow,
} from './repositories/attachment.repository';
import { mutationQueueRepository } from './repositories/mutation-queue.repository';
import type { ImageUploaderHandle } from './image-uploader-instance';

const MAX_CONCURRENT = 2;
const MAX_UPLOAD_ATTEMPTS = 8;
const MAX_DEFER_ATTEMPTS = 60;
const DEFER_INTERVAL_MS = 5_000;
const BACKOFF_CAP_MS = 5 * 60_000;

type MutationQueueStatus =
  'pending' | 'pushing' | 'applied' | 'rejected' | 'dead' | string;

type ParentCreateMutation = {
  action: string;
  status: MutationQueueStatus;
};

const stageFn = STAGE_FILE.uploadMutationOptions<TempUploadResponse>()
  .mutationFn as unknown as (vars: UploadParams) => Promise<TempUploadResponse>;

const commitFn = COMMIT_FILES.mutationOptions<
  FileResponse[],
  CommitFilesRequest
>().mutationFn as unknown as (
  vars: RequestParams<CommitFilesRequest>,
) => Promise<FileResponse[]>;

async function isOnline(): Promise<boolean> {
  const state = await NetInfo.fetch();

  return Boolean(state.isConnected) && state.isInternetReachable !== false;
}

function toNormalizedError(err: unknown): Partial<NormalizedError> {
  if (err && typeof err === 'object') {
    return err as Partial<NormalizedError>;
  }

  return {
    message: err instanceof Error ? err.message : 'Upload failed.',
  };
}

function isParentTerminal(create?: ParentCreateMutation): boolean {
  return create?.status === 'rejected' || create?.status === 'dead';
}

function isParentApplied(create?: ParentCreateMutation): boolean {
  // A MISSING create mutation is NOT "applied" — it means the parent draft
  // hasn't been saved yet. Images are only ever captured against a brand-new
  // draft record (e.g. CreateProductScreen generates the guuid, the photo is
  // attached to it BEFORE Save, and Save enqueues the create under that same
  // guuid). So until an `applied` create exists, committing would attach to a
  // record the server has never seen → 409 file_parent_not_found. Defer instead
  // (an abandoned draft eventually orphans via MAX_DEFER_ATTEMPTS).
  //
  // NOTE: this assumes applied create mutations are retained in the queue
  // (markApplied keeps the row) — true today. If images ever become attachable
  // to a pre-existing, already-synced record (no local create mutation), this
  // gate needs a local record-existence check instead of a bare create lookup.
  return create?.status === 'applied';
}

function nextBackoffMs(attempts: number): number {
  const base = Math.min(2 ** attempts * 1000, BACKOFF_CAP_MS);
  return Math.round(base * (0.5 + Math.random()));
}

/**
 * Background image uploader.
 *
 * This is intentionally separate from the JSON mutation queue: stalled media
 * uploads should not block normal business mutations from syncing.
 *
 * Flow:
 * 1. Find pending attachment rows.
 * 2. Wait until the parent record create has synced.
 * 3. Stage the local file.
 * 4. Commit the staged file to the parent record.
 * 5. Delete the local original and keep the thumbnail/cache copy.
 */
export class ImageUploader implements ImageUploaderHandle {
  private running = false;
  private rerun = false;
  private recovered = false;

  constructor(private readonly storeId: string) {}

  wake(): void {
    if (this.running) {
      this.rerun = true;
      return;
    }

    void this.drain();
  }

  requeueBlocked(): void {
    void attachmentRepository
      .requeueBlocked(getSyncDb(), this.storeId)
      .then(() => this.wake());
  }

  private async drain(): Promise<void> {
    if (this.running) {
      this.rerun = true;
      return;
    }

    this.running = true;

    try {
      if (!this.recovered) {
        await attachmentRepository.resetInFlight(getSyncDb(), this.storeId);
        this.recovered = true;
      }

      do {
        this.rerun = false;

        while (await isOnline()) {
          const batch = await attachmentRepository.findPending(
            getSyncDb(),
            this.storeId,
            Date.now(),
            MAX_CONCURRENT,
          );

          if (batch.length === 0) break;

          await Promise.all(
            batch.map((attachment) => this.uploadOne(attachment)),
          );
        }
      } while (this.rerun);
    } finally {
      this.running = false;

      if (this.rerun) {
        this.rerun = false;
        this.wake();
      }
    }
  }

  private async findParentCreate(
    att: AttachmentRow,
  ): Promise<ParentCreateMutation | undefined> {
    const mutations = await mutationQueueRepository.findByEntityGuuid(
      getSyncDb(),
      att.recordGuuid,
    );

    return mutations.find((mutation) => mutation.action === 'create') as
      ParentCreateMutation | undefined;
  }

  private async uploadOne(att: AttachmentRow): Promise<void> {
    const db = getSyncDb();

    try {
      const parentCreate = await this.findParentCreate(att);

      if (isParentTerminal(parentCreate)) {
        await this.markOrphaned(att);
        return;
      }

      if (!isParentApplied(parentCreate)) {
        await this.defer(att);
        return;
      }

      let tempGuuid = att.tempGuuid;

      if (!tempGuuid) {
        await attachmentRepository.update(db, att.guuid, {
          status: 'staging',
          lastError: null,
          lastErrorCode: null,
        });

        const formData = new FormData();

        formData.append('file', {
          uri: att.localPath,
          name: `${att.guuid}.jpg`,
          type: att.mimeType ?? 'image/jpeg',
        } as unknown as Blob);

        formData.append('entity_type', att.entityType);
        formData.append('kind', att.kind);

        const staged = await stageFn({
          pathParam: { storeId: this.storeId },
          formData,
        });

        tempGuuid = staged.guuid;

        await attachmentRepository.markStaged(db, att.guuid, tempGuuid);
      }

      await attachmentRepository.update(db, att.guuid, {
        status: 'committing',
        lastError: null,
        lastErrorCode: null,
      });

      const committed = await commitFn({
        pathParam: { storeId: this.storeId },
        bodyParam: {
          entity_type: att.entityType,
          record_guuid: att.recordGuuid,
          kind: att.kind,
          file_guuids: [tempGuuid],
        },
      });

      const serverFileGuuid = committed[0]?.guuid;

      if (!serverFileGuuid) {
        throw {
          status: 502,
          code: 'FILE_COMMIT_EMPTY_RESPONSE',
          message: 'File commit succeeded but returned no file id.',
          isOffline: false,
        } satisfies NormalizedError;
      }

      await attachmentRepository.markCommitted(db, att.guuid, serverFileGuuid);

      await this.deleteLocalOriginal(att);
    } catch (err) {
      await this.handleFailure(att, err);
    }
  }

  private async defer(att: AttachmentRow): Promise<void> {
    const db = getSyncDb();
    const next = att.deferCount + 1;

    if (next > MAX_DEFER_ATTEMPTS) {
      const parentCreate = await this.findParentCreate(att);

      if (!parentCreate || isParentTerminal(parentCreate)) {
        await this.markOrphaned(att);
        return;
      }

      await attachmentRepository.update(db, att.guuid, {
        status: 'pending_upload',
        nextAttemptAt: Date.now() + BACKOFF_CAP_MS,
      });

      return;
    }

    await attachmentRepository.update(db, att.guuid, {
      status: 'pending_upload',
      deferCount: next,
      nextAttemptAt: Date.now() + DEFER_INTERVAL_MS,
    });
  }

  /**
   * Server says the parent does not exist.
   *
   * That can be temporary if the parent create is still waiting in the mutation
   * queue. Only orphan the image when the parent create is terminally failed.
   */
  private async deferOrOrphan(att: AttachmentRow): Promise<void> {
    const parentCreate = await this.findParentCreate(att);

    if (isParentTerminal(parentCreate)) {
      await this.markOrphaned(att);
      return;
    }

    await this.defer(att);
  }

  private async markOrphaned(att: AttachmentRow): Promise<void> {
    await attachmentRepository.markOrphaned(getSyncDb(), att.guuid, Date.now());
    await this.deleteLocalFiles(att);
  }

  private async deleteLocalOriginal(att: AttachmentRow): Promise<void> {
    if (!att.localPath) return;

    await FileSystem.deleteAsync(att.localPath, {
      idempotent: true,
    }).catch(() => undefined);
  }

  private async deleteLocalFiles(att: AttachmentRow): Promise<void> {
    await Promise.all([
      att.localPath
        ? FileSystem.deleteAsync(att.localPath, {
            idempotent: true,
          }).catch(() => undefined)
        : Promise.resolve(),
      att.localThumbPath
        ? FileSystem.deleteAsync(att.localThumbPath, {
            idempotent: true,
          }).catch(() => undefined)
        : Promise.resolve(),
    ]);
  }

  private async handleFailure(att: AttachmentRow, err: unknown): Promise<void> {
    const db = getSyncDb();
    const error = toNormalizedError(err);
    // Wire error codes arrive lowercase (the backend exception filter renders
    // `errorCode` in snake_case, e.g. `file_parent_not_found`), and
    // normalizeError() surfaces that value verbatim as `code`. Compare against
    // the lowercase form — matching the UPPER_SNAKE constant names silently
    // never fires, dropping every case below into the generic 409-is-not-
    // transient path and marking the image permanently `failed`.
    const code = (error.code ?? '').toLowerCase();
    const status = error.status ?? 0;
    const message = error.message ?? null;

    if (code === 'file_parent_not_found') {
      await this.deferOrOrphan(att);
      return;
    }

    if (code === 'temp_file_expired') {
      await attachmentRepository.update(db, att.guuid, {
        status: 'pending_upload',
        tempGuuid: null,
        nextAttemptAt: null,
        lastError: message,
        lastErrorCode: code,
      });

      return;
    }

    if (code.startsWith('subscription')) {
      await attachmentRepository.update(db, att.guuid, {
        status: 'blocked',
        lastError: message,
        lastErrorCode: code,
      });

      return;
    }

    const attempts = att.attemptCount + 1;
    const transient =
      error.isOffline ||
      status === 0 ||
      status === 408 ||
      status === 429 ||
      status >= 500;

    if (transient && attempts < MAX_UPLOAD_ATTEMPTS) {
      await attachmentRepository.update(db, att.guuid, {
        status: 'pending_upload',
        attemptCount: attempts,
        nextAttemptAt: Date.now() + nextBackoffMs(attempts),
        lastError: message,
        lastErrorCode: code || null,
      });

      return;
    }

    await attachmentRepository.update(db, att.guuid, {
      status: 'failed',
      attemptCount: attempts,
      nextAttemptAt: null,
      lastError: message,
      lastErrorCode: code || null,
    });
  }
}
