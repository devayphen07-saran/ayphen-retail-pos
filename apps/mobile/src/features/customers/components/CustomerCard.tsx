import { memo } from 'react';
import { useMobileTheme } from '@ayphen/mobile-theme';
import { Column, Typography } from '@ayphen/mobile-ui-components';
import type { LocalCustomer } from '@core/sync/repositories/customer.repository';

export const CustomerCard = memo(function CustomerCard({ customer }: { customer: LocalCustomer }) {
  const { theme } = useMobileTheme();
  const subtitle = [customer.phone, customer.email].filter(Boolean).join(' · ');
  return (
    <Column
      gap={2}
      style={{ paddingVertical: theme.sizing.small, paddingHorizontal: theme.sizing.medium }}
    >
      <Typography.Body weight="medium">{customer.name}</Typography.Body>
      {subtitle ? (
        <Typography.Caption type="secondary">{subtitle}</Typography.Caption>
      ) : null}
    </Column>
  );
});
