import React from "react";
import { ViewStyle, StyleProp } from "react-native";
import styled from "styled-components/native";
import { useMobileTheme } from "@ayphen/mobile-theme";
import { Typography } from "../typography";
import { LucideIcon, LucideIconNameType } from "../lucide-icon";
import { Row } from "../layout";


// ─── Types ──────────────────────────────────────────────────────────────

export interface MetricCardProps {
  label: string;
  value: string;
  valueColor?: string;
  iconName?: LucideIconNameType;
  iconColor?: string;
  trend?: string;
  trendColor?: string;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
  flex?: number;
}

// ─── Component ──────────────────────────────────────────────────────────

export const MetricCard: React.FC<MetricCardProps> = (props) => {
  const { theme } = useMobileTheme();
  const {
    label,
    value,
    valueColor,
    iconName,
    iconColor = theme.colorPrimary,
    trend,
    trendColor,
    onPress,
    style,
    flex,
  } = props;

  return (
    <CardContainer
      onPress={onPress}
      disabled={!onPress}
      activeOpacity={0.7}
      style={[style, { flex }]}
    >
      <HeaderRow align="center" justify="space-between">
        <Typography.Caption type="secondary" weight="medium">
          {label}
        </Typography.Caption>
        {iconName && (
          <LucideIcon name={iconName} size={16} color={iconColor} />
        )}
      </HeaderRow>

      <Typography.H5 weight="bold" color={valueColor || theme.colorText}>
        {value}
      </Typography.H5>

      {trend && (
        <TrendCaption
          weight="semiBold"
          color={trendColor || theme.colorTextTertiary}
        >
          {trend}
        </TrendCaption>
      )}
    </CardContainer>
  );
};

export default MetricCard;

// ─── Styles ─────────────────────────────────────────────────────────────

const CardContainer = styled.TouchableOpacity`
  background-color: ${({ theme }) => theme.colorBgContainer};
  border-radius: ${({ theme }) => theme.borderRadius.medium}px;
  padding: ${({ theme }) => theme.sizing.large}px;
  border-width: ${({ theme }) => theme.borderWidth.thin}px;
  border-color: ${({ theme }) => theme.colorBorderSecondary};
`;

const HeaderRow = styled(Row)`
  margin-bottom: ${({ theme }) => theme.sizing.xxSmall}px;
`;

const TrendCaption = styled(Typography.Caption)`
  margin-top: ${({ theme }) => theme.sizing.xxSmall}px;
`;
