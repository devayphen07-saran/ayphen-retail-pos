import { useMemo, useState } from 'react';
import { and, eq, inArray } from 'drizzle-orm';
import { useLiveQuery } from 'drizzle-orm/expo-sqlite/query';
import {
  AppScrollLayout,
  Card,
  Column,
  ConflictRow,
  Row,
  SectionHeader,
  Tag,
  Typography,
} from '@ayphen/mobile-ui-components';
import { getSyncDbForQueries } from '@core/sync/db/client';
import { mutationQueue, failedApplies } from '@core/sync/db/schema';
import type { MutationQueueRow } from '@core/sync/repositories/mutation-queue.repository';
import { takeServerVersion, resubmitMine } from '@core/sync/mutations/resolve-conflict';
import { useActiveStoreStore } from '@store';
import { summarize, entityLabel } from '../utils/format-sync-row';

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
 *  - the pull-side apply DLQ (visibility only — those are server rows that
 *    failed to apply locally, e.g. a missing FK not yet synced; no client
 *    action can force that either)
 */
export function ConflictsScreen() {
  const storeId = useActiveStoreStore((s) => s.storeId) ?? '';
  const [resolvingId, setResolvingId] = useState<string | null>(null);

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

  const handleKeepMine = async (row: MutationQueueRow) => {
    setResolvingId(row.mutationId);
    try {
      await resubmitMine(storeId, row);
    } finally {
      setResolvingId(null);
    }
  };

  const handleKeepServer = async (row: MutationQueueRow) => {
    setResolvingId(row.mutationId);
    try {
      await takeServerVersion(storeId, row);
    } finally {
      setResolvingId(null);
    }
  };

  const hasConflicts = (conflicts?.length ?? 0) > 0;
  const hasRejected = (rejected?.length ?? 0) > 0;
  const hasFailed = (failed?.length ?? 0) > 0;

  return (
    <AppScrollLayout title="Sync Issues">
      <Column gap={4}>
        <SectionHeader title="Conflicts to resolve" />
        {hasConflicts ? (
          (conflicts ?? []).map((row) => {
            const payload = JSON.parse(row.payload) as Record<string, unknown>;
            const serverRow = row.serverRow ? (JSON.parse(row.serverRow) as Record<string, unknown>) : {};
            return (
              <ConflictRow
                key={row.mutationId}
                entityLabel={entityLabel(row.entityType)}
                local={{
                  label: 'Your edit',
                  value: summarize(payload, row.entityGuuid),
                  changedAtMs: new Date(row.clientModifiedAt).getTime(),
                }}
                server={{
                  label: 'Server version',
                  value: summarize(serverRow, row.entityGuuid),
                  changedAtMs: serverRow.modified_at ? new Date(serverRow.modified_at as string).getTime() : null,
                }}
                onKeepLocal={() => void handleKeepMine(row)}
                onKeepServer={() => void handleKeepServer(row)}
                busy={resolvingId === row.mutationId}
              />
            );
          })
        ) : (
          <Typography.Caption type="secondary">No conflicts — you're all caught up.</Typography.Caption>
        )}

        <SectionHeader title="Couldn't be sent" />
        {hasRejected ? (
          (rejected ?? []).map((row) => (
            <Card key={row.mutationId} padding="small">
              <Column gap={2}>
                <Row align="center" gap={6}>
                  <Typography.Body weight="medium">{entityLabel(row.entityType)}</Typography.Body>
                  {row.status === 'dead' ? <Tag label="Gave up retrying" variant="danger" size="sm" /> : null}
                </Row>
                <Typography.Caption type="secondary">
                  {row.errorMessage ?? 'The server rejected this change.'}
                </Typography.Caption>
              </Column>
            </Card>
          ))
        ) : (
          <Typography.Caption type="secondary">Nothing rejected — every change was accepted.</Typography.Caption>
        )}

        <SectionHeader title="Couldn't apply" />
        {hasFailed ? (
          (failed ?? []).map((row) => (
            <Card key={row.id} padding="small">
              <Typography.Body weight="medium">{entityLabel(row.entityType)}</Typography.Body>
              <Typography.Caption type="secondary">{row.lastError ?? 'Unknown error'}</Typography.Caption>
            </Card>
          ))
        ) : (
          <Typography.Caption type="secondary">Nothing stuck — all incoming changes applied.</Typography.Caption>
        )}
      </Column>
    </AppScrollLayout>
  );
}
