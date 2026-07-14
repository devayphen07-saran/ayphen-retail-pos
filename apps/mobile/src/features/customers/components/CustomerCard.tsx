import { memo } from 'react';
import styled from 'styled-components/native';
import { useMobileTheme } from '@ayphen/mobile-theme';
import { Avatar, Card, Column, Row, Typography } from '@ayphen/mobile-ui-components';
import type { LocalCustomer } from '@core/sync/repositories/customer.repository';

export const CustomerCard = memo(function CustomerCard({
  customer,
  onPress,
}: {
  customer: LocalCustomer;
  onPress?: () => void;
}) {
  const { theme } = useMobileTheme();
  const subtitle = [customer.phone, customer.email].filter(Boolean).join(' · ');
  const initials = customer.name.trim().slice(0, 2).toUpperCase() || '?';

  return (
    <CardMargin onPress={onPress} bordered={false} padding="none">
      <Row align="center" gap="small" padding="small">
        <Avatar initials={initials} size={40} shape="circle" />
        <Column flex={1} gap={theme.sizing.xxSmall}>
          <Typography.Body weight="medium" numberOfLines={1}>
            {customer.name}
          </Typography.Body>
          <Typography.Caption type="secondary" numberOfLines={1}>
            {subtitle || 'No contact details'}
          </Typography.Caption>
        </Column>
      </Row>
    </CardMargin>
  );
});

const CardMargin = styled(Card)`
  margin-horizontal: ${({ theme }) => theme.sizing.xxSmall}px;
`;
