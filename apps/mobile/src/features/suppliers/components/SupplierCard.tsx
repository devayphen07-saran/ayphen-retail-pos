import { memo } from 'react';
import { useMobileTheme } from '@ayphen/mobile-theme';
import { Column, Typography } from '@ayphen/mobile-ui-components';
import type { LocalSupplier } from '@core/sync/repositories/supplier.repository';

export const SupplierCard = memo(function SupplierCard({ supplier }: { supplier: LocalSupplier }) {
  const { theme } = useMobileTheme();
  const subtitle = [supplier.phone, supplier.email].filter(Boolean).join(' · ');
  return (
    <Column
      gap={2}
      style={{ paddingVertical: theme.sizing.small, paddingHorizontal: theme.sizing.medium }}
    >
      <Typography.Body weight="medium">{supplier.name}</Typography.Body>
      {subtitle ? (
        <Typography.Caption type="secondary">{subtitle}</Typography.Caption>
      ) : null}
    </Column>
  );
});
