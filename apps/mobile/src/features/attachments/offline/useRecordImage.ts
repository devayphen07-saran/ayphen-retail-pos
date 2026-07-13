import { useMemo } from 'react';
import { and, eq, isNull } from 'drizzle-orm';
import { useLiveQuery } from 'drizzle-orm/expo-sqlite/query';
import { getSyncDbForQueries } from '@core/sync/db/client';
import { attachment } from '@core/sync/db/schema';
import type { AttachmentStatus } from '@core/sync/repositories/attachment.repository';

/** The primary local attachment for a record, plus its upload state for the badge. */
export interface LocalRecordImage {
  attachmentGuuid: string;
  localThumbPath: string | null;
  fileGuuid: string | null; // server files.guuid once committed — the stable cacheKey
  status: AttachmentStatus;
}

/**
 * Reactive local read of a record's image (image-offline-architecture.md §C5
 * display). Polymorphic — keyed only by the parent `recordGuuid`. Re-runs on
 * every local write via `useLiveQuery`, so a freshly captured photo appears
 * instantly and its badge updates as the uploader progresses. Returns the
 * *primary* (oldest) live attachment, or null when this device has no local
 * image — in which case the caller falls back to the remote fetch, then a
 * placeholder.
 */
export function useRecordImage(recordGuuid: string): LocalRecordImage | null {
  const query = useMemo(
    () =>
      getSyncDbForQueries()
        .select()
        .from(attachment)
        .where(and(eq(attachment.recordGuuid, recordGuuid), isNull(attachment.deletedAt))),
    [recordGuuid],
  );
  const { data } = useLiveQuery(query, [recordGuuid]);

  return useMemo(() => {
    const rows = data ?? [];
    if (rows.length === 0) return null;
    // Primary = oldest by createdAt (the first image attached to the record).
    const primary = [...rows].sort((a, b) => a.createdAt - b.createdAt)[0]!;
    return {
      attachmentGuuid: primary.guuid,
      localThumbPath: primary.localThumbPath,
      fileGuuid: primary.fileGuuid,
      status: primary.status,
    };
  }, [data]);
}
