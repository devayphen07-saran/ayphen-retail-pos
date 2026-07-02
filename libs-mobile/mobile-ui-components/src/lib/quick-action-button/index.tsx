import React from "react";
import { TouchableOpacityProps } from "react-native";
import styled from "styled-components/native";
import { ColorType, useMobileTheme, useBreakpoint } from "@nks/mobile-theme";
import { LucideIcon, LucideIconNameType } from "../lucide-icon";
import { Typography } from "../typography";
import { Row, Flex } from "../layout";

// ─── Types ──────────────────────────────────────────────────────────────

export interface QuickActionButtonProps extends TouchableOpacityProps {
  title: string;
  description: string;
  icon?: LucideIconNameType;
  arrow?: boolean;
  iconColor?: ColorType;
  rightIcon?: LucideIconNameType;
  bgColor?: string;
}

// ─── Component ──────────────────────────────────────────────────────────

export const QuickActionButton: React.FC<QuickActionButtonProps> = ({
  title,
  description,
  icon,
  arrow = false,
  iconColor = ColorType.primary,
  rightIcon,
  bgColor,
  ...buttonProps
}) => {
  const { theme } = useMobileTheme();
  const { scale } = useBreakpoint();
  const innerIconSize = Math.round(17 * scale);

  return (
    <QuickButtonContainer
      {...buttonProps}
      activeOpacity={0.9}
      $bgColor={bgColor}
      $scale={scale}
    >
      <Row justify="space-between" align="center">
        <Row gap={theme.sizing.small}>
          {icon && (
            <IconContainer $scale={scale}>
              <LucideIcon
                name={icon}
                size={innerIconSize}
                color={theme.color[iconColor]?.main || theme.colorPrimary}
              />
            </IconContainer>
          )}
          <Flex flex={1}>
            <Typography.Caption
              weight="medium"
              ellipsizeMode="tail"
              numberOfLines={1}
              style={{ color: theme.colorText }}
            >
              {title}
            </Typography.Caption>
            <Typography.Overline
              ellipsizeMode="tail"
              numberOfLines={1}
              style={{
                marginTop: theme.sizing.xxSmall,
                color: theme.colorTextSecondary,
              }}
            >
              {description}
            </Typography.Overline>
          </Flex>
        </Row>

        {arrow && (
          <LucideIcon name="ChevronRight" size={innerIconSize} color={theme.colorText} />
        )}
        {rightIcon && (
          <LucideIcon
            name={rightIcon}
            size={innerIconSize}
            color={theme.color[iconColor]?.main || theme.colorPrimary}
          />
        )}
      </Row>
    </QuickButtonContainer>
  );
};

export default QuickActionButton;

// ─── Styles ─────────────────────────────────────────────────────────────

const QuickButtonContainer = styled.TouchableOpacity<{ $bgColor?: string; $scale: number }>`
  padding: ${({ theme, $scale }) => theme.sizing.small * $scale}px;
  background-color: ${({ $bgColor, theme }) =>
    $bgColor || theme.colorBgContainer};
  border-radius: ${({ theme }) => theme.borderRadius.xLarge}px;
  flex: 1;
  border-width: ${({ theme }) => theme.borderWidth.mild}px;
  border-color: ${({ theme }) => theme.colorBorder};
`;

const IconContainer = styled.View<{ $scale: number }>`
  width: ${({ theme, $scale }) => (theme.sizing.xLarge + 4) * $scale}px;
  height: ${({ theme, $scale }) => (theme.sizing.xLarge + 4) * $scale}px;
  border-radius: ${({ theme }) => theme.borderRadius.regular}px;
  background-color: ${({ theme }) => theme.color.primary.bg};
  align-items: center;
  justify-content: center;
`;
