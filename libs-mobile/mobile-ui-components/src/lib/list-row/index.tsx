import React from "react";
import styled from "styled-components/native";
import { TouchableOpacity, ViewStyle } from "react-native";
import { Flex, Row } from "../layout/Flex";
import { Typography } from "../typography";
import { LucideIcon, LucideIconNameType } from "../lucide-icon";
import { useBreakpoint, useMobileTheme } from "@nks/mobile-theme";

interface ListRowProps {
  icon: LucideIconNameType;
  iconColor?: string;
  title: string;
  subtitle?: string;
  onPress?: () => void;
  style?: ViewStyle;
  chevron?: boolean;
}

export const ListRow: React.FC<ListRowProps> = ({
  icon,
  iconColor,
  title,
  subtitle,
  onPress,
  style,
  chevron = true,
}) => {
  const { scale } = useBreakpoint();
  const { theme } = useMobileTheme();
  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.8} style={style}>
      <RowContainer $scale={scale} align="center">
        <IconSlot $scale={scale}>
          <LucideIcon name={icon} color={iconColor} size={Math.round(22 * scale)} />
        </IconSlot>
        <ContentFlex $scale={scale}>
          <Typography.Subtitle weight="bold">
            {title}
          </Typography.Subtitle>
          {subtitle ? (
            <Typography.Caption type="secondary">
              {subtitle}
            </Typography.Caption>
          ) : null}
        </ContentFlex>
        {chevron && <LucideIcon name="ChevronRight" size={Math.round(18 * scale)} color={theme.colorTextTertiary} />}
      </RowContainer>
    </TouchableOpacity>
  );
};

const RowContainer = styled(Row)<{ $scale: number }>`
  padding-vertical: ${({ $scale, theme }) => theme.sizing.medium * $scale}px;
  min-height: ${({ $scale }) => 56 * $scale}px;
`;

const IconSlot = styled(Flex)<{ $scale: number }>`
  width: ${({ $scale, theme }) => theme.sizing.xLarge * $scale}px;
  align-items: center;
  justify-content: center;
  margin-right: ${({ $scale, theme }) => theme.sizing.small * $scale}px;
`;

const ContentFlex = styled(Flex)<{ $scale: number }>`
  flex: 1;
  margin-left: 0;
  gap: ${({ $scale, theme }) => theme.sizing.xxSmall * $scale}px;
`;