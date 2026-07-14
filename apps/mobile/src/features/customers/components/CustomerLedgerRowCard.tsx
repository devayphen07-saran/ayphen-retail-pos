import { memo } from 'react';
import styled from 'styled-components/native';
import { useMobileTheme } from '@ayphen/mobile-theme';
import { Column, LucideIcon, LucideIconNameType, Row, Tag, Typography, formatMinorUnits } from '@ayphen/mobile-ui-components';
import type { LocalCustomerLedgerEvent } from '@core/sync/repositories/customer-ledger-event.repository';

type Tint = 'primary' | 'success' | 'warning' | 'neutral';

const KIND_META: Record<string, { label: string; icon: LucideIconNameType; tint: Tint }> = {
  credit_sale: { label: 'Credit sale', icon: 'ShoppingBag', tint: 'primary' },
  payment: { label: 'Payment received', icon: 'HandCoins', tint: 'success' },
  credit_note: { label: 'Refund (credit)', icon: 'RotateCcw', tint: 'warning' },
  adjustment: { label: 'Adjustment', icon: 'SlidersHorizontal', tint: 'neutral' },
};

/** Mirrors computeOutstandingPaise's sign convention — payment/credit_note
 *  lower what's owed, credit_sale raises it. */
function isReducing(kind: string | null): boolean {
  return kind === 'payment' || kind === 'credit_note';
}

export const CustomerLedgerRowCard = memo(function CustomerLedgerRowCard({
  event,
}: {
  event: LocalCustomerLedgerEvent;
}) {
  const { theme } = useMobileTheme();
  const meta = KIND_META[event.kind ?? ''] ?? {
    label: event.kind ?? 'Activity',
    icon: 'Receipt' as LucideIconNameType,
    tint: 'neutral' as Tint,
  };
  const tintColors: Record<Tint, { bg: string; fg: string }> = {
    primary: { bg: theme.color.primary.bg, fg: theme.color.primary.main },
    success: { bg: theme.color.success.bg, fg: theme.colorSuccess },
    warning: { bg: theme.color.warning.bg, fg: theme.colorWarning },
    neutral: { bg: theme.color.grey.bg, fg: theme.color.grey.main },
  };
  const tint = tintColors[meta.tint];
  const reducing = isReducing(event.kind);

  return (
    <RowPad align="center" gap="small">
      <IconChip $bg={tint.bg}>
        <LucideIcon name={meta.icon} size={18} color={tint.fg} />
      </IconChip>

      <Column gap={theme.sizing.xxSmall} flex={1}>
        <Typography.Body weight="medium">{meta.label}</Typography.Body>
        <Row align="center" gap="xSmall">
          <Typography.Caption type="secondary">
            {event.modifiedAt ? new Date(event.modifiedAt).toLocaleString() : ''}
          </Typography.Caption>
          {event.flagged ? <Tag label="Flagged" variant="warning" size="xsm" iconName="TriangleAlert" /> : null}
        </Row>
      </Column>

      <Typography.Body weight="semiBold" color={reducing ? theme.colorSuccess : theme.colorText}>
        {reducing ? '−' : '+'}
        {formatMinorUnits(event.amountPaise, { currency: 'INR' })}
      </Typography.Body>
    </RowPad>
  );
});

const RowPad = styled(Row)`
  padding-vertical: ${({ theme }) => theme.sizing.small}px;
  padding-horizontal: ${({ theme }) => theme.sizing.medium}px;
`;

const IconChip = styled.View<{ $bg: string }>`
  width: 36px;
  height: 36px;
  border-radius: ${({ theme }) => theme.borderRadius.large}px;
  align-items: center;
  justify-content: center;
  background-color: ${({ $bg }) => $bg};
`;