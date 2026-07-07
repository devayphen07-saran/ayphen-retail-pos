import { memo } from 'react';
import { View } from 'react-native';
import styled from 'styled-components/native';
import { useMobileTheme } from '@ayphen/mobile-theme';
import { Column, LucideIcon, Row, Tag, Typography } from '@ayphen/mobile-ui-components';
import type { LocationResponse } from '@ayphen/api-manager';

export interface LocationCardProps {
  location: LocationResponse;
  busy: boolean;
  onPress: (location: LocationResponse) => void;
}

export const LocationCard = memo(function LocationCard({ location, busy, onPress }: LocationCardProps) {
  const { theme } = useMobileTheme();
  return (
    <CardContainer
      onPress={() => onPress(location)}
      activeOpacity={0.7}
      disabled={busy}
      $disabled={!location.enable || busy}
    >
      <Row align="center" gap={12}>
        <IconSlot $disabled={!location.enable}>
          <LucideIcon
            name="MapPin"
            size={20}
            color={location.enable ? theme.colorPrimary : theme.colorTextTertiary}
          />
        </IconSlot>
        <Column flex={1} gap={4}>
          <Typography.Body
            weight="medium"
            color={location.enable ? undefined : theme.colorTextTertiary}
          >
            {location.name}
          </Typography.Body>
          <Row gap={6}>
            {location.is_primary && <Tag label="Head Office" variant="info" size="sm" />}
            {location.is_default && <Tag label="Default" variant="success" size="sm" />}
            {!location.enable && <Tag label="Disabled" variant="default" size="sm" />}
            {location.is_locked && (
              <Tag label="Locked — plan downgrade" variant="danger" size="sm" />
            )}
          </Row>
        </Column>
        <LucideIcon name="ChevronRight" size={16} color={theme.colorTextTertiary} />
      </Row>
    </CardContainer>
  );
});

function locationCardStyle(disabled: boolean) {
  return disabled ? { opacity: 0.55 } : undefined;
}

const CardContainer = styled.TouchableOpacity.attrs<{ $disabled?: boolean }>((props) => ({
  style: locationCardStyle(!!props.$disabled),
}))<{ $disabled?: boolean }>`
  background-color: ${({ theme }) => theme.colorBgContainer};
  border-radius: ${({ theme }) => theme.borderRadius.xLarge}px;
  border-width: ${({ theme }) => theme.borderWidth.thin}px;
  border-color: ${({ theme }) => theme.colorBorder};
  padding: ${({ theme }) => theme.sizing.medium}px;
`;

const IconSlot = styled(View)<{ $disabled?: boolean }>`
  width: 40px;
  height: 40px;
  border-radius: ${({ theme }) => theme.borderRadius.large}px;
  align-items: center;
  justify-content: center;
  background-color: ${({ theme, $disabled }) =>
    $disabled ? theme.colorFillSecondary ?? theme.colorBorder : theme.color.primary.bg};
`;
