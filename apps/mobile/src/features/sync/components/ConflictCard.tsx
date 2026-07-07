import { memo } from 'react';
import { ConflictRow } from '@ayphen/mobile-ui-components';
import type { MutationQueueRow } from '@core/sync/repositories/mutation-queue.repository';

export interface ConflictItem {
  row: MutationQueueRow;
  entityLabel: string;
  localValue: string;
  localChangedAtMs: number;
  serverValue: string;
  serverChangedAtMs: number | null;
}

export const ConflictCard = memo(function ConflictCard({
  item,
  busy,
  onKeepLocal,
  onKeepServer,
}: {
  item: ConflictItem;
  busy: boolean;
  onKeepLocal: (row: MutationQueueRow) => void;
  onKeepServer: (row: MutationQueueRow) => void;
}) {
  return (
    <ConflictRow
      entityLabel={item.entityLabel}
      local={{ label: 'Your edit', value: item.localValue, changedAtMs: item.localChangedAtMs }}
      server={{ label: 'Server version', value: item.serverValue, changedAtMs: item.serverChangedAtMs }}
      onKeepLocal={() => onKeepLocal(item.row)}
      onKeepServer={() => onKeepServer(item.row)}
      busy={busy}
    />
  );
});