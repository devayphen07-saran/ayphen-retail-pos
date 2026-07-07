import { memo } from 'react';
import { useMobileTheme } from '@ayphen/mobile-theme';
import { Button, Card, Column, LucideIcon, Row, Tag, Typography } from '@ayphen/mobile-ui-components';
import type { FailedApplyRow } from '@core/sync/repositories/failed-applies.repository';
import { entityLabel } from '../utils/format-sync-row';

export const FailedCard = memo(function FailedCard({
  row,
  busy,
  onDismiss,
}: {
  row: FailedApplyRow;
  busy: boolean;
  onDismiss: (id: number) => void;
}) {
  const { theme } = useMobileTheme();
  return (
    <Card padding="small" style={{ borderLeftWidth: 3, borderLeftColor: theme.color.warning.main }}>
      <Column gap={8}>
        <Row align="center" gap={10}>
          <LucideIcon name="CloudOff" size={18} color={theme.color.warning.main} />
          <Column flex={1} gap={2}>
            <Row align="center" gap={6}>
              <Typography.Body weight="semiBold">{entityLabel(row.entityType)}</Typography.Body>
              {row.attempts > 1 ? <Tag label={`Tried ${row.attempts}×`} variant="warning" size="sm" /> : null}
            </Row>
            <Typography.Caption type="secondary">{row.lastError ?? 'Unknown error'}</Typography.Caption>
          </Column>
        </Row>
        <Button
          label="Dismiss"
          variant="dashed"
          onPress={() => onDismiss(row.id)}
          disabled={busy}
          accessibilityLabel={`Dismiss the stuck ${entityLabel(row.entityType)} change`}
        />
      </Column>
    </Card>
  );
});