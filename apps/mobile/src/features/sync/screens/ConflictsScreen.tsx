import { useCallback, useMemo, useState } from 'react';
import { View } from 'react-native';
import { and, eq, inArray } from 'drizzle-orm';
import { useLiveQuery } from 'drizzle-orm/expo-sqlite/query';
import { FlashList, type ListRenderItemInfo } from '@shopify/flash-list';
import { useMobileTheme } from '@ayphen/mobile-theme';
import {
  Alert,
  AppLayout,
  Button,
  SectionHeader,
  type LucideIconNameType,
} from '@ayphen/mobile-ui-components';
import { getSyncDb, getSyncDbForQueries } from '@core/sync/db/client';
import { mutationQueue, failedApplies } from '@core/sync/db/schema';
import type { MutationQueueRow } from '@core/sync/repositories/mutation-queue.repository';
import { failedAppliesRepository, type FailedApplyRow } from '@core/sync/repositories/failed-applies.repository';
import { retryFailedApplies } from '@core/sync/engine/retry-failed-applies';
import { takeServerVersion, resubmitMine } from '@core/sync/mutations/resolve-conflict';
import { useActiveStoreStore } from '@store';
import { summarize, entityLabel } from '../utils/format-sync-row';
import { StatusCard } from '../components/StatusCard';
import { ConflictCard, type ConflictItem } from '../components/ConflictCard';
import { RejectedCard } from '../components/RejectedCard';
import { FailedCard } from '../components/FailedCard';

// Discriminated row model for the ONE FlashList this screen renders — mutation-
// queue/DLQ backlogs are NOT bounded the way roles/devices are (an
// extended offline period or a bad release can grow either into the dozens),
// so this must be virtualized rather than a ScrollView+map like those bounded
// lists. `gap` picks between the small within-section spacing and the larger
// gap before the next section's header, replacing what Column's `gap` prop
// did when everything rendered inside one non-virtualized tree.
type Row_ =
  | { kind: 'header'; key: string; title: string; gap: number }
  | { kind: 'status'; key: string; icon: LucideIconNameType; tone: 'success' | 'info'; text: string; gap: number }
  | { kind: 'retry-all'; key: string; gap: number }
  | { kind: 'conflict'; key: string; item: ConflictItem; gap: number }
  | { kind: 'rejected'; key: string; row: MutationQueueRow; gap: number }
  | { kind: 'failed'; key: string; row: FailedApplyRow; gap: number };

const GAP_WITHIN_SECTION = 8;
const GAP_AFTER_HEADER = 10;
const GAP_BETWEEN_SECTIONS = 24;

/**
 * Sync Issues screen (mobile-11 §11) — surfaces the three things the
 * queue-drain engine can't resolve on its own:
 *  - row-version conflicts (actionable here — keep mine / use server's)
 *  - rejected/dead-lettered pushes (visibility only — a rejection is
 *    terminal because the SERVER refused the payload itself, e.g. a
 *    validation error; blindly resubmitting the same stored payload would
 *    just be rejected again, and a generic "roll back the optimistic write"
 *    action would need entity-specific knowledge this screen doesn't have —
 *    reconcile-mutation-result.ts's own comment makes the same call)
 *  - the pull-side apply DLQ (a missing-FK row auto-retries after each pull
 *    once its parent arrives; this screen adds a manual "Retry" for the
 *    impatient and "Dismiss" to drop a row the user knows is junk)
 */
export function ConflictsScreen() {
  const { theme } = useMobileTheme();
  const storeId = useActiveStoreStore((s) => s.storeId) ?? '';
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  // -1 is the sentinel for the store-wide "Retry all" (retryFailedApplies is
  // store-scoped, not per-row); a real row id means that row's "Dismiss".
  const [busyFailedId, setBusyFailedId] = useState<number | null>(null);

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

  // Writes still queued (offline / draining) — surfaced so queued changes are
  // never invisible: without this the user has no signal a write hasn't reached
  // the server yet (mobile-11 honest-offline UX).
  const pendingQuery = useMemo(
    () =>
      getSyncDbForQueries()
        .select()
        .from(mutationQueue)
        .where(and(eq(mutationQueue.storeId, storeId), inArray(mutationQueue.status, ['pending', 'inflight']))),
    [storeId],
  );
  const { data: pending } = useLiveQuery(pendingQuery, [storeId]);
  const pendingCount = pending?.length ?? 0;

  // Each resolve action MUST catch its own failure — these run fire-and-forget
  // from a button's onPress (no caller awaits or handles a rejection), so
  // without a catch here a failed write silently looks like a success: the
  // button just stops spinning with no other feedback.
  const handleKeepMine = useCallback(async (row: MutationQueueRow) => {
    setResolvingId(row.mutationId);
    try {
      await resubmitMine(storeId, row);
    } catch {
      Alert.info('Error', "Couldn't apply your choice — check your connection and try again.");
    } finally {
      setResolvingId(null);
    }
  }, [storeId]);

  const handleKeepServer = useCallback(async (row: MutationQueueRow) => {
    setResolvingId(row.mutationId);
    try {
      await takeServerVersion(storeId, row);
    } catch {
      Alert.info('Error', "Couldn't apply your choice — check your connection and try again.");
    } finally {
      setResolvingId(null);
    }
  }, [storeId]);

  // Store-wide retry — re-applies every DLQ row under the poison cap (the same
  // pass the engine runs automatically after each pull). useLiveQuery drops the
  // rows that now apply on its own.
  const handleRetryFailed = useCallback(async () => {
    setBusyFailedId(-1);
    try {
      await retryFailedApplies(getSyncDb(), storeId, new Date().toISOString());
    } catch {
      Alert.info('Error', "Couldn't retry — check your connection and try again.");
    } finally {
      setBusyFailedId(null);
    }
  }, [storeId]);

  const handleDismissFailed = useCallback(async (id: number) => {
    setBusyFailedId(id);
    try {
      await failedAppliesRepository.deleteById(getSyncDb(), id);
    } catch {
      Alert.info('Error', "Couldn't dismiss this item — try again.");
    } finally {
      setBusyFailedId(null);
    }
  }, []);

  // Parse each conflict's payload/serverRow ONCE, memoized on the query result —
  // not inside the render map, where it re-ran JSON.parse for every row on every
  // re-render (e.g. each "Keep mine" tap flipping `resolvingId`).
  const conflictItems = useMemo(
    () =>
      (conflicts ?? []).map((row) => {
        const payload = JSON.parse(row.payload) as Record<string, unknown>;
        const serverRow = row.serverRow ? (JSON.parse(row.serverRow) as Record<string, unknown>) : {};
        return {
          row,
          entityLabel: entityLabel(row.entityType),
          localValue: summarize(payload, row.entityGuuid),
          localChangedAtMs: new Date(row.clientModifiedAt).getTime(),
          serverValue: summarize(serverRow, row.entityGuuid),
          serverChangedAtMs: serverRow.modified_at
            ? new Date(serverRow.modified_at as string).getTime()
            : null,
        };
      }),
    [conflicts],
  );

  const rows = useMemo<Row_[]>(() => {
    const out: Row_[] = [];

    out.push({
      kind: 'header',
      key: 'h-pending',
      title: pendingCount > 0 ? `Waiting to sync (${pendingCount})` : 'Waiting to sync',
      gap: GAP_AFTER_HEADER,
    });
    out.push(
      pendingCount > 0
        ? {
            kind: 'status', key: 's-pending', icon: 'RefreshCw', tone: 'info',
            text: `${pendingCount} change${pendingCount === 1 ? '' : 's'} waiting to sync — they upload automatically once you're back online.`,
            gap: GAP_BETWEEN_SECTIONS,
          }
        : { kind: 'status', key: 's-pending', icon: 'CheckCircle2', tone: 'success', text: 'All changes are synced.', gap: GAP_BETWEEN_SECTIONS },
    );

    out.push({
      kind: 'header',
      key: 'h-conflicts',
      title: conflictItems.length > 0 ? `Conflicts to resolve (${conflictItems.length})` : 'Conflicts to resolve',
      gap: GAP_AFTER_HEADER,
    });
    if (conflictItems.length > 0) {
      conflictItems.forEach((item, i) => {
        out.push({
          kind: 'conflict', key: `c-${item.row.mutationId}`, item,
          gap: i === conflictItems.length - 1 ? GAP_BETWEEN_SECTIONS : GAP_WITHIN_SECTION,
        });
      });
    } else {
      out.push({ kind: 'status', key: 's-conflicts', icon: 'CheckCircle2', tone: 'success', text: "No conflicts — you're all caught up.", gap: GAP_BETWEEN_SECTIONS });
    }

    const rejectedRows = rejected ?? [];
    out.push({
      kind: 'header',
      key: 'h-rejected',
      title: rejectedRows.length > 0 ? `Couldn't be sent (${rejectedRows.length})` : "Couldn't be sent",
      gap: GAP_AFTER_HEADER,
    });
    if (rejectedRows.length > 0) {
      rejectedRows.forEach((row, i) => {
        out.push({
          kind: 'rejected', key: `r-${row.mutationId}`, row,
          gap: i === rejectedRows.length - 1 ? GAP_BETWEEN_SECTIONS : GAP_WITHIN_SECTION,
        });
      });
    } else {
      out.push({ kind: 'status', key: 's-rejected', icon: 'CheckCircle2', tone: 'success', text: 'Nothing rejected — every change was accepted.', gap: GAP_BETWEEN_SECTIONS });
    }

    const failedRows = failed ?? [];
    out.push({
      kind: 'header',
      key: 'h-failed',
      title: failedRows.length > 0 ? `Couldn't apply (${failedRows.length})` : "Couldn't apply",
      gap: GAP_AFTER_HEADER,
    });
    if (failedRows.length > 0) {
      out.push({ kind: 'retry-all', key: 'retry-all', gap: GAP_WITHIN_SECTION });
      failedRows.forEach((row, i) => {
        out.push({
          kind: 'failed', key: `f-${row.id}`, row,
          gap: i === failedRows.length - 1 ? 0 : GAP_WITHIN_SECTION,
        });
      });
    } else {
      out.push({ kind: 'status', key: 's-failed', icon: 'CheckCircle2', tone: 'success', text: 'Nothing stuck — all incoming changes applied.', gap: 0 });
    }

    return out;
  }, [pendingCount, conflictItems, rejected, failed]);

  const renderItem = useCallback(({ item }: ListRenderItemInfo<Row_>) => {
    switch (item.kind) {
      case 'header':
        return (
          <View style={{ paddingBottom: item.gap }}>
            <SectionHeader title={item.title} containerStyle={{ paddingHorizontal: 0 }} />
          </View>
        );
      case 'status':
        return (
          <View style={{ paddingBottom: item.gap }}>
            <StatusCard icon={item.icon} tone={item.tone} text={item.text} />
          </View>
        );
      case 'retry-all':
        return (
          <View style={{ paddingBottom: item.gap }}>
            <Button
              label="Retry all"
              variant="dashed"
              onPress={() => void handleRetryFailed()}
              disabled={busyFailedId !== null}
              accessibilityLabel="Retry applying all stuck changes"
            />
          </View>
        );
      case 'conflict':
        return (
          <View style={{ paddingBottom: item.gap }}>
            <ConflictCard
              item={item.item}
              busy={resolvingId === item.item.row.mutationId}
              onKeepLocal={handleKeepMine}
              onKeepServer={handleKeepServer}
            />
          </View>
        );
      case 'rejected':
        return (
          <View style={{ paddingBottom: item.gap }}>
            <RejectedCard row={item.row} />
          </View>
        );
      case 'failed':
        return (
          <View style={{ paddingBottom: item.gap }}>
            <FailedCard
              row={item.row}
              busy={busyFailedId !== null}
              onDismiss={handleDismissFailed}
            />
          </View>
        );
    }
  }, [resolvingId, busyFailedId, handleKeepMine, handleKeepServer, handleRetryFailed, handleDismissFailed]);

  return (
    <AppLayout title="Sync Issues">
      <FlashList<Row_>
        data={rows}
        keyExtractor={(item) => item.key}
        renderItem={renderItem}
        contentContainerStyle={{ padding: theme.sizing.large, paddingBottom: 40 }}
        showsVerticalScrollIndicator={false}
      />
    </AppLayout>
  );
}