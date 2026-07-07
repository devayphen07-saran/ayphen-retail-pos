import { ActivityIndicator, TouchableOpacity } from 'react-native';
import styled from 'styled-components/native';
import { useMobileTheme } from '@ayphen/mobile-theme';
import { LucideIcon, Row, Column, Typography } from '@ayphen/mobile-ui-components';

export interface ModeCardProps {
  icon: 'Store' | 'User';
  accentBg: string;
  accentIcon: string;
  title: string;
  description: string;
  selected: boolean;
  loading: boolean;
  disabled: boolean;
  onPress: () => void;
}

export function ModeCard({
  icon,
  accentBg,
  accentIcon,
  title,
  description,
  selected,
  loading,
  disabled,
  onPress,
}: ModeCardProps) {
  const { theme } = useMobileTheme();
  return (
    <CardBtn
      onPress={onPress}
      activeOpacity={0.82}
      disabled={disabled}
      $selected={selected}
      accessibilityRole="button"
      accessibilityLabel={`${title}: ${description}`}
      accessibilityState={{ disabled, busy: loading }}
    >
      <Row align="center" gap={14}>
        <IconTile style={{ backgroundColor: accentBg }}>
          <LucideIcon name={icon} size={24} color={accentIcon} />
        </IconTile>

        <Column flex={1} gap={3}>
          <Typography.Body weight="semiBold" color={theme.colorText}>
            {title}
          </Typography.Body>
          <Typography.Caption color={theme.color.grey.active}>
            {description}
          </Typography.Caption>
        </Column>

        {loading ? (
          <ActivityIndicator color={theme.colorPrimary} size="small" />
        ) : selected ? (
          <LucideIcon name="CheckCircle" size={20} color={theme.colorPrimary} />
        ) : (
          <LucideIcon
            name="ChevronRight"
            size={20}
            color={theme.colorTextQuaternary}
          />
        )}
      </Row>
    </CardBtn>
  );
}

const CardBtn = styled(TouchableOpacity)<{ $selected: boolean }>`
  flex-direction: row;
  align-items: center;
  padding: ${({ theme }) => theme.sizing.medium}px;
  border-radius: 16px;
  border-width: ${({ theme }) => theme.borderWidth.light}px;
  border-color: ${({ $selected, theme }) => ($selected ? theme.colorPrimary : theme.colorBorder)};
  background-color: ${({ $selected, theme }) => ($selected ? theme.color.primary.bg : theme.color.grey.bg)};
`;

const IconTile = styled.View`
  width: 52px;
  height: 52px;
  border-radius: ${({ theme }) => theme.borderRadius.xxLarge}px;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
`;