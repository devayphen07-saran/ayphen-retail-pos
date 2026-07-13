import { and, asc, eq, inArray, isNull, lte, or } from 'drizzle-orm';
import { attachment } from '../db/schema';
import type { SyncDb } from '../db/types';

export type AttachmentStatus =
  | 'pending_upload'
  | 'staging'
  | 'staged'
  | 'committing'
  | 'committed'
  | 'failed'
  | 'blocked'
  | 'orphaned';

export type AttachmentRow = typeof attachment.$inferSelect;
export type NewAttachment = typeof attachment.$inferInsert;

/** Fields the uploader patches as an attachment moves through its lifecycle. */
export interface AttachmentPatch {
  status?: AttachmentStatus;
  tempGuuid?: string | null;
  fileGuuid?: string | null;
  localPath?: string | null;
  localThumbPath?: string | null;
  attemptCount?: number;
  deferCount?: number;
  nextAttemptAt?: number | null;
  lastError?: string | null;
  lastErrorCode?: string | null;
  deletedAt?: number | null;
}

/**
 * Device-local upload bookkeeping (image-offline-architecture.md C3/C4). This is
 * the durable work-list for the background uploader — every method takes the
 * `SyncDb` so it can run inside the caller's transaction. Not a synced table.
 *
 * `status` is the upload state machine; `deletedAt` is existence. Deletion is a
 * soft-delete (set `deletedAt`), never a `status` value.
 */
export const attachmentRepository = {
  async insert(db: SyncDb, row: NewAttachment): Promise<void> {
    await db.insert(attachment).values(row);
  },

  async get(db: SyncDb, guuid: string): Promise<AttachmentRow | undefined> {
    const [row] = await db.select().from(attachment).where(eq(attachment.guuid, guuid)).limit(1);
    return row;
  },

  /**
   * The uploader's drain list: pending rows whose backoff gate has elapsed
   * (`next_attempt_at` null or in the past), oldest first. Store-scoped.
   */
  async findPending(db: SyncDb, storeId: string, now: number, limit: number): Promise<AttachmentRow[]> {
    return db
      .select()
      .from(attachment)
      .where(
        and(
          eq(attachment.storeFk, storeId),
          eq(attachment.status, 'pending_upload'),
          isNull(attachment.deletedAt),
          or(isNull(attachment.nextAttemptAt), lte(attachment.nextAttemptAt, now)),
        ),
      )
      .orderBy(asc(attachment.createdAt))
      .limit(limit);
  },

  /** Active (non-deleted) attachments for one parent record — the display read. */
  async findByRecordGuuid(db: SyncDb, recordGuuid: string): Promise<AttachmentRow[]> {
    return db
      .select()
      .from(attachment)
      .where(and(eq(attachment.recordGuuid, recordGuuid), isNull(attachment.deletedAt)))
      .orderBy(asc(attachment.createdAt));
  },

  /** Active attachments for many parent records — the grid display read. */
  async findByRecordGuuids(db: SyncDb, recordGuuids: string[]): Promise<AttachmentRow[]> {
    if (recordGuuids.length === 0) return [];
    return db
      .select()
      .from(attachment)
      .where(and(inArray(attachment.recordGuuid, recordGuuids), isNull(attachment.deletedAt)));
  },

  async update(db: SyncDb, guuid: string, patch: AttachmentPatch): Promise<void> {
    await db.update(attachment).set(patch).where(eq(attachment.guuid, guuid));
  },

  /** Stage succeeded — hold the server temp handle. */
  async markStaged(db: SyncDb, guuid: string, tempGuuid: string): Promise<void> {
    await this.update(db, guuid, { status: 'staged', tempGuuid, lastError: null, lastErrorCode: null });
  },

  /**
   * Commit succeeded — record the server `files.guuid` (the stable expo-image
   * cacheKey) and drop the local original path. The caller deletes the file on
   * disk after this commits; the thumbnail is retained.
   */
  async markCommitted(db: SyncDb, guuid: string, fileGuuid: string): Promise<void> {
    await this.update(db, guuid, {
      status: 'committed',
      fileGuuid,
      localPath: null,
      lastError: null,
      lastErrorCode: null,
    });
  },

  /** Parent gone/dead (P1-11/P1-12) — soft-delete; caller cleans local files. */
  async markOrphaned(db: SyncDb, guuid: string, now: number): Promise<void> {
    await this.update(db, guuid, { status: 'orphaned', deletedAt: now });
  },

  /** Explicit user removal — soft-delete. */
  async softDelete(db: SyncDb, guuid: string, now: number): Promise<void> {
    await this.update(db, guuid, { deletedAt: now });
  },

  /**
   * Recovery after an app kill: revert rows stuck mid-flight (`staging`/
   * `committing`) back to `pending_upload` so the uploader retries them. Safe to
   * run at uploader start — a fresh uploader instance means nothing is genuinely
   * in flight. The server `claimed_at` gate + temp TTL make a re-attempt exactly-
   * once and orphan-free.
   */
  async resetInFlight(db: SyncDb, storeId: string): Promise<void> {
    await db
      .update(attachment)
      .set({ status: 'pending_upload', tempGuuid: null, nextAttemptAt: null })
      .where(
        and(
          eq(attachment.storeFk, storeId),
          inArray(attachment.status, ['staging', 'committing']),
          isNull(attachment.deletedAt),
        ),
      );
  },

  /**
   * Subscription reactivated (P1-14): move every `blocked` row back to
   * `pending_upload` so the uploader retries them — no per-photo user tap.
   */
  async requeueBlocked(db: SyncDb, storeId: string): Promise<void> {
    await db
      .update(attachment)
      .set({ status: 'pending_upload', nextAttemptAt: null, lastError: null, lastErrorCode: null })
      .where(
        and(
          eq(attachment.storeFk, storeId),
          eq(attachment.status, 'blocked'),
          isNull(attachment.deletedAt),
        ),
      );
  },
};
