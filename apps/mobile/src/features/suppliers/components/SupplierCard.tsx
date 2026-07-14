import { memo } from 'react';
import styled from 'styled-components/native';
import { useMobileTheme } from '@ayphen/mobile-theme';
import { Avatar, Card, Column, Row, Typography } from '@ayphen/mobile-ui-components';
import type { LocalSupplier } from '@core/sync/repositories/supplier.repository';

/** `Card` has no `margin` prop — this supplies the horizontal margin as real CSS. */
const CardMarginWrapper = styled.View`
  margin-left: ${({ theme }) => theme.sizing.xxSmall}px;
  margin-right: ${({ theme }) => theme.sizing.xxSmall}px;
`;

export const SupplierCard = memo(function SupplierCard({
  supplier,
  onPress,
}: {
  supplier: LocalSupplier;
  onPress?: () => void;
}) {
  const { theme } = useMobileTheme();
  const subtitle = [supplier.phone, supplier.email].filter(Boolean).join(' · ');
  const initials = supplier.name.trim().slice(0, 2).toUpperCase() || '?';

  return (
    <CardMarginWrapper>
      <Card onPress={onPress} bordered={false} padding="none">
        <Row align="center" gap="small" padding={theme.sizing.small}>
          <Avatar initials={initials} size={40} shape="circle" />
          <Column flex={1} gap={theme.sizing.xxSmall}>
            <Typography.Body weight="medium" numberOfLines={1}>
              {supplier.name}
            </Typography.Body>
            <Typography.Caption type="secondary" numberOfLines={1}>
              {subtitle || 'No contact details'}
            </Typography.Caption>
          </Column>
        </Row>
      </Card>
    </CardMarginWrapper>
  );
});
