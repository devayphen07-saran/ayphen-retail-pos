import { useMemo } from 'react';
import { and, eq, inArray } from 'drizzle-orm';
import { useLiveQuery } from 'drizzle-orm/expo-sqlite/query';
import { getSyncDbForQueries } from '@core/sync/db/client';
import { mutationQueue, failedApplies } from '@core/sync/db/schema';
import { useActiveStoreStore } from '@store';

/**
 * Count of sync issues that need the user's attention (conflicts, rejected/
 * dead-lettered pushes, stuck apply-DLQ rows) — the same three sections
 * ConflictsScreen renders, minus "waiting to sync", which isn't a problem.
 * Reactive via useLiveQuery, so a badge built on this updates itself as the
 * queue drains without any polling.
 */
export function useSyncIssueCount(): number {
  const storeId = useActiveStoreStore((s) => s.storeId) ?? '';

  const conflictsQuery = useMemo(
    () =>
      getSyncDbForQueries()
        .select()
        .from(mutationQueue)
        .where(and(eq(mutationQueue.storeId, storeId), eq(mutationQueue.status, 'conflict'))),
    [storeId],
  );
  const { data: conflicts } = useLiveQuery(conflictsQuery, [storeId]);

  const rejectedQuery = useMemo(
    () =>
      getSyncDbForQueries()
        .select()
        .from(mutationQueue)
        .where(and(eq(mutationQueue.storeId, storeId), inArray(mutationQueue.status, ['rejected', 'dead']))),
    [storeId],
  );
  const { data: rejected } = useLiveQuery(rejectedQuery, [storeId]);

  const failedQuery = useMemo(
    () => getSyncDbForQueries().select().from(failedApplies).where(eq(failedApplies.storeId, storeId)),
    [storeId],
  );
  const { data: failed } = useLiveQuery(failedQuery, [storeId]);

  return (conflicts?.length ?? 0) + (rejected?.length ?? 0) + (failed?.length ?? 0);
}
