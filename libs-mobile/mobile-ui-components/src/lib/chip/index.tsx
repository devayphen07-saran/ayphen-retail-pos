import React from 'react';
import { TouchableOpacity, ViewStyle } from 'react-native';
import styled from 'styled-components/native';
import { useMobileTheme } from '@ayphen/mobile-theme';
import { Typography } from '../typography';

// ─── Types ──────────────────────────────────────────────────────────────

export type ChipSize = 'sm' | 'md';
export type ChipVariant =
  | 'default'
  | 'primary'
  | 'success'
  | 'danger'
  | 'warning';

export interface ChipProps {
  label: string;
  onPress?: () => void;
  active?: boolean;
  size?: ChipSize;
  variant?: ChipVariant;
  disabled?: boolean;
  style?: ViewStyle;
}

// ─── Component ──────────────────────────────────────────────────────────

export const Chip: React.FC<ChipProps> = ({
  label,
  onPress,
  active = false,
  size = 'md',
  variant = 'default',
  disabled = false,
  style,
}) => {
  const { theme } = useMobileTheme();

  const getVariantColors = (v: ChipVariant, isActive: boolean) => {
    const variants: Record<
      ChipVariant,
      { bg: string; border: string; text: string }
    > = {
      default: {
        bg: isActive ? theme.color.primary.bg : theme.colorBgContainer,
        border: isActive ? theme.colorPrimary : theme.colorBorderSecondary,
        text: isActive ? theme.colorPrimary : theme.colorTextSecondary,
      },
      primary: {
        bg: isActive ? theme.color.primary.bg : theme.colorBgContainer,
        border: isActive
          ? theme.color.primary.main
          : theme.colorBorderSecondary,
        text: isActive ? theme.color.primary.main : theme.colorTextSecondary,
      },
      success: {
        bg: isActive ? theme.color.success.bg : theme.colorBgContainer,
        border: isActive
          ? theme.color.success.main
          : theme.colorBorderSecondary,
        text: isActive ? theme.color.success.main : theme.colorTextSecondary,
      },
      danger: {
        bg: isActive ? theme.color.danger.bg : theme.colorBgContainer,
        border: isActive ? theme.color.danger.main : theme.colorBorderSecondary,
        text: isActive ? theme.color.danger.main : theme.colorTextSecondary,
      },
      warning: {
        bg: isActive ? theme.color.warning.bg : theme.colorBgContainer,
        border: isActive
          ? theme.color.warning.main
          : theme.colorBorderSecondary,
        text: isActive ? theme.color.warning.main : theme.colorTextSecondary,
      },
    };
    return variants[v];
  };

  const colors = getVariantColors(variant, active);

  return (
    <ChipButton
      $bg={colors.bg}
      $borderColor={colors.border}
      $textColor={colors.text}
      $size={size}
      $disabled={disabled}
      onPress={onPress}
      disabled={disabled}
      style={style}
      activeOpacity={0.7}
    >
      <ChipLabel $size={size} $color={colors.text}>
        {label}
      </ChipLabel>
    </ChipButton>
  );
};

export default Chip;

// ─── Styles ─────────────────────────────────────────────────────────────

const ChipButton = styled(TouchableOpacity)<{
  $bg: string;
  $borderColor: string;
  $textColor: string;
  $size: ChipSize;
  $disabled: boolean;
}>`
  padding-left: ${({ $size, theme }) =>
    $size === 'sm' ? theme.componentSizing.chipPaddingHorizontalSm : theme.sizing.small}px;
  padding-right: ${({ $size, theme }) =>
    $size === 'sm' ? theme.componentSizing.chipPaddingHorizontalSm : theme.sizing.small}px;
  height: ${({ $size, theme }) =>
    $size === 'sm' ? theme.componentSizing.chipHeightSm : theme.componentSizing.chipHeightMd}px;
  border-radius: ${({ theme }) => theme.borderRadius.full}px;
  justify-content: center;
  align-items: center;
  border-width: ${({ theme }) => theme.borderWidth.thin}px;
  background-color: ${({ $bg }) => $bg};
  border-color: ${({ $borderColor }) => $borderColor};
  opacity: ${({ $disabled }) => ($disabled ? 0.5 : 1)};
`;

const ChipLabel = styled(Typography.Body)<{ $size: ChipSize; $color: string }>`
  font-size: ${({ $size, theme }) =>
    $size === 'sm' ? theme.fontSize.xSmall : theme.fontSize.small}px;
  font-weight: ${({ theme }) => theme.fontWeight['600']};
  color: ${({ $color }) => $color};
`;
