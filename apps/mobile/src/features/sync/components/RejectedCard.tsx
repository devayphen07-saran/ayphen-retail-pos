import { memo } from 'react';
import { useMobileTheme } from '@ayphen/mobile-theme';
import { Card, Column, LucideIcon, Row, Tag, Typography } from '@ayphen/mobile-ui-components';
import type { MutationQueueRow } from '@core/sync/repositories/mutation-queue.repository';
import { entityLabel } from '../utils/format-sync-row';

export const RejectedCard = memo(function RejectedCard({ row }: { row: MutationQueueRow }) {
  const { theme } = useMobileTheme();
  return (
    <Card padding="small" style={{ borderLeftWidth: 3, borderLeftColor: theme.color.danger.main }}>
      <Row align="center" gap={10}>
        <LucideIcon
          name={row.status === 'dead' ? 'CircleOff' : 'AlertTriangle'}
          size={18}
          color={theme.color.danger.main}
        />
        <Column flex={1} gap={2}>
          <Row align="center" gap={6}>
            <Typography.Body weight="semiBold">{entityLabel(row.entityType)}</Typography.Body>
            {row.status === 'dead' ? <Tag label="Gave up retrying" variant="danger" size="sm" /> : null}
          </Row>
          <Typography.Caption type="secondary">
            {row.errorMessage ?? 'The server rejected this change.'}
          </Typography.Caption>
        </Column>
      </Row>
    </Card>
  );
});