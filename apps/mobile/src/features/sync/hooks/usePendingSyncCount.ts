import { useMemo } from 'react';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { useLiveQuery } from 'drizzle-orm/expo-sqlite/query';
import { getSyncDbForQueries } from '@core/sync/db/client';
import { mutationQueue, attachment } from '@core/sync/db/schema';
import { useActiveStoreStore } from '@store';

/** Queue states that are "waiting to sync" — normal in-flight work, NOT a
 *  problem (conflict/rejected/dead/failed are surfaced by useSyncIssueCount). */
const PENDING_MUTATION_STATES = ['pending', 'inflight'] as const;
/** Attachment states still in the upload pipeline (not committed/failed/orphaned). */
const PENDING_UPLOAD_STATES = ['pending_upload', 'staging', 'committing'] as const;

export interface PendingSyncCounts {
  /** Queued local edits/sales not yet pushed to the server. */
  pendingWrites: number;
  /** Image uploads still in the stage→commit pipeline. */
  pendingUploads: number;
  /** pendingWrites + pendingUploads. */
  total: number;
}

/**
 * Reactive count of local work still waiting to reach the server for the active
 * store: queued mutations (offline edits not yet pushed) + in-flight image
 * uploads. Distinct from `useSyncIssueCount`, which counts PROBLEMS needing
 * attention. Drives a "syncing… / N pending / all synced" indicator and the
 * pre-logout warning — these are exactly the rows a logout-wipe would discard.
 * Reactive via useLiveQuery, so it updates itself as the queue drains.
 */
export function usePendingSyncCount(): PendingSyncCounts {
  const storeId = useActiveStoreStore((s) => s.storeId) ?? '';

  const writesQuery = useMemo(
    () =>
      getSyncDbForQueries()
        .select({ id: mutationQueue.mutationId })
        .from(mutationQueue)
        .where(
          and(
            eq(mutationQueue.storeId, storeId),
            inArray(mutationQueue.status, [...PENDING_MUTATION_STATES]),
          ),
        ),
    [storeId],
  );
  const { data: writes } = useLiveQuery(writesQuery, [storeId]);

  const uploadsQuery = useMemo(
    () =>
      getSyncDbForQueries()
        .select({ guuid: attachment.guuid })
        .from(attachment)
        .where(
          and(
            eq(attachment.storeFk, storeId),
            isNull(attachment.deletedAt),
            inArray(attachment.status, [...PENDING_UPLOAD_STATES]),
          ),
        ),
    [storeId],
  );
  const { data: uploads } = useLiveQuery(uploadsQuery, [storeId]);

  const pendingWrites = writes?.length ?? 0;
  const pendingUploads = uploads?.length ?? 0;
  return { pendingWrites, pendingUploads, total: pendingWrites + pendingUploads };
}
