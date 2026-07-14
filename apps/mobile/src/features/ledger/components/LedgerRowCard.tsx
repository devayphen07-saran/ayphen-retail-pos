import { memo } from 'react';
import styled from 'styled-components/native';
import { useMobileTheme } from '@ayphen/mobile-theme';
import { Column, Row, Typography, formatMinorUnits } from '@ayphen/mobile-ui-components';
import type { LedgerRow } from '../utils/ledger-row';

const REASON_LABEL: Record<string, string> = {
  opening_balance: 'Opening balance',
  float: 'Float',
  payin: 'Cash in',
  payout: 'Cash out',
  drop: 'Cash drop',
  tip: 'Tip',
  count: 'Cash count',
  variance: 'Variance',
  sale: 'Sale',
  refund: 'Refund',
  vendor_payment: 'Vendor payment',
  credit_payment: 'Credit payment received',
};

export const LedgerRowCard = memo(function LedgerRowCard({ row }: { row: LedgerRow }) {
  const { theme } = useMobileTheme();
  const isCredit = row.direction === 'credit';
  const amountColor = isCredit ? theme.colorSuccess : theme.colorError;

  return (
    <RowPad align="center" justify="space-between" $pending={row.pending}>
      <Column gap={theme.sizing.xxSmall} flex={1}>
        <Typography.Body weight="medium">
          {REASON_LABEL[row.reason] ?? row.reason}
        </Typography.Body>
        <Typography.Caption type="secondary">
          {row.pending ? 'Syncing…' : new Date(row.modifiedAt).toLocaleString()}
          {row.note ? ` · ${row.note}` : ''}
        </Typography.Caption>
      </Column>
      <Typography.Body weight="semiBold" color={amountColor}>
        {isCredit ? '+' : '−'}
        {formatMinorUnits(row.amountPaise, { currency: 'INR' })}
      </Typography.Body>
    </RowPad>
  );
});

const RowPad = styled(Row)<{ $pending?: boolean }>`
  padding-vertical: ${({ theme }) => theme.sizing.small}px;
  padding-horizontal: ${({ theme }) => theme.sizing.medium}px;
  opacity: ${({ $pending }) => ($pending ? 0.6 : 1)};
`;