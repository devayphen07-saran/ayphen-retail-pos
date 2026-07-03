import React from "react";
import { TouchableOpacity, ViewStyle, Platform } from "react-native";
import styled, { css } from "styled-components/native";
import { useBreakpoint } from "@ayphen/mobile-theme";

// ─── Types ──────────────────────────────────────────────────────────────

export type CardPadding = "none" | "small" | "medium" | "large";

interface CardProps {
  children?: React.ReactNode;
  bordered?: boolean;
  shadow?: boolean;
  padding?: CardPadding;
  style?: ViewStyle;
  onPress?: () => void;
  backgroundColor?: string;
}

// ─── Component ──────────────────────────────────────────────────────────

export const Card: React.FC<CardProps> = ({
  children,
  bordered = true,
  shadow = false,
  padding = "medium",
  style,
  onPress,
  backgroundColor,
}) => {
  const { scale } = useBreakpoint();
  const content = (
    <CardBase
      $bordered={bordered}
      $shadow={shadow}
      $padding={padding}
      $scale={scale}
      $backgroundColor={backgroundColor}
      style={!onPress ? style : undefined}
    >
      {children}
    </CardBase>
  );

  if (onPress) {
    return (
      <TouchableOpacity activeOpacity={0.8} onPress={onPress} style={style}>
        {content}
      </TouchableOpacity>
    );
  }

  return content;
};

export default Card;

// ─── Styles ─────────────────────────────────────────────────────────────

const CardBase = styled.View<{
  $bordered: boolean;
  $shadow: boolean;
  $backgroundColor?: string;
  $padding: CardPadding;
  $scale: number;
}>`
  background-color: ${({ theme, $backgroundColor }) =>
    $backgroundColor || theme.colorBgContainer};
  border-radius: ${({ theme }) => theme.borderRadius.large}px;
  border-width: ${({ theme, $bordered }) =>
    $bordered ? theme.borderWidth.thin : 0}px;
  border-color: ${({ theme }) => theme.colorBorder};
  overflow: hidden;

  padding: ${({ $padding, theme, $scale }) => {
    switch ($padding) {
      case "small":
        return theme.sizing.xSmall * $scale;
      case "medium":
        return theme.sizing.medium * $scale;
      case "large":
        return theme.sizing.large * $scale;
      default:
        return 0;
    }
  }}px;

  ${({ $shadow, theme }) =>
    $shadow &&
    Platform.select({
      ios: css`
        shadow-color: ${theme.colorText};
        shadow-opacity: 0.08;
        shadow-radius: 8px;
        shadow-offset: 0px 4px;
      `,
      android: css`
        elevation: 3;
      `,
    })}
`;
