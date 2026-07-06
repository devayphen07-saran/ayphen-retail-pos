import React from "react";
import { ViewStyle, FlexAlignType } from "react-native";
import styled from "styled-components/native";
import { useMobileTheme } from "@ayphen/mobile-theme";
import { Typography } from "../typography";
import { LucideIcon, LucideIconNameType } from "../lucide-icon";

// ─── Types ──────────────────────────────────────────────────────────────

export type TagSize = "xsm" | "sm" | "md" | "lg";
export type TagVariant = "primary" | "success" | "danger" | "info" | "warning" | "default";

interface TagProps {
  label: string | number;
  iconName?: LucideIconNameType;
  iconSize?: number;
  size?: TagSize;
  variant?: TagVariant;
  color?: string;
  backgroundColor?: string;
  borderColor?: string;
  style?: ViewStyle;
  alignSelf?: FlexAlignType;
}

// ─── Component ──────────────────────────────────────────────────────────

export const Tag: React.FC<TagProps> = ({
  label,
  iconName,
  iconSize = 10,
  size = "md",
  variant = "default",
  color,
  backgroundColor,
  borderColor,
  style,
  alignSelf = "flex-start",
}) => {
  const { theme } = useMobileTheme();

  const getVariantMappedColors = (v: TagVariant) => {
    switch (v) {
      case "primary":
        return {
          bg: theme.color.primary.main,
          text: theme.colorWhite,
          border: theme.color.primary.border,
        };
      case "success":
        return {
          bg: theme.color.success.bg,
          text: theme.color.success.main,
          border: theme.color.success.border,
        };
      case "danger":
        return {
          bg: theme.color.danger.bg,
          text: theme.color.danger.main,
          border: theme.color.danger.border,
        };
      case "warning":
        return {
          bg: theme.color.warning.bg,
          text: theme.color.warning.main,
          border: theme.color.warning.border,
        };
      case "info":
        return {
          bg: theme.color.blue.bg,
          text: theme.color.blue.main,
          border: theme.color.blue.border,
        };
      default:
        return {
          bg: theme.color.secondary.bg,
          text: theme.color.secondary.main,
          border: theme.color.secondary.border,
        };
    }
  };

  const colors = getVariantMappedColors(variant);

  return (
    <TagContainer
      $bg={backgroundColor || colors.bg}
      $border={borderColor || colors.border}
      $size={size}
      $alignSelf={alignSelf}
      style={style}
    >
      {iconName && (
        <IconWrap>
          <LucideIcon name={iconName} size={iconSize} color={color || colors.text} />
        </IconWrap>
      )}

      <TagLabel $size={size} $color={color || colors.text}>
        {label}
      </TagLabel>
    </TagContainer>
  );
};

export default Tag;

// ─── Styles ─────────────────────────────────────────────────────────────

const TagContainer = styled.View<{
  $bg: string;
  $border: string;
  $size: TagSize;
  $alignSelf: FlexAlignType;
}>`
  flex-direction: row;
  align-items: center;
  justify-content: center;
  align-self: ${({ $alignSelf }) => $alignSelf};

  background-color: ${({ $bg }) => $bg};
  border-color: ${({ $border }) => $border};
  border-width: ${({ theme }) => theme.borderWidth.thin}px;
  border-radius: ${({ $size, theme }) => {
    const radiusMap = {
      xsm: theme.borderRadius.small,
      sm: theme.borderRadius.small + 1,
      md: theme.borderRadius.medium,
      lg: theme.borderRadius.medium,
    };
    return radiusMap[$size];
  }}px;

  padding-top: ${({ $size, theme }) => {
    // xsm=2 and sm=3 intentionally use sub-token values for the smallest tag sizes
    const vMap = { xsm: 2, sm: 3, md: theme.sizing.xxSmall, lg: theme.sizing.xSmall };
    return vMap[$size];
  }}px;
  padding-bottom: ${({ $size, theme }) => {
    // xsm=2 and sm=3 intentionally use sub-token values for the smallest tag sizes
    const vMap = { xsm: 2, sm: 3, md: theme.sizing.xxSmall, lg: theme.sizing.xSmall };
    return vMap[$size];
  }}px;
  padding-left: ${({ $size, theme }) => {
    const hMap = {
      xsm: theme.sizing.xSmall,
      sm: theme.sizing.xSmall,
      md: theme.sizing.small,
      lg: theme.sizing.regular,
    };
    return hMap[$size];
  }}px;
  padding-right: ${({ $size, theme }) => {
    const hMap = {
      xsm: theme.sizing.xSmall,
      sm: theme.sizing.xSmall,
      md: theme.sizing.small,
      lg: theme.sizing.regular,
    };
    return hMap[$size];
  }}px;
`;

const IconWrap = styled.View`
  margin-right: ${({ theme }) => theme.sizing.xxSmall}px;
`;

const TagLabel = styled(Typography.Subtitle)<{
  $color: string;
  $size: TagSize;
}>`
  color: ${({ $color }) => $color};
  font-size: ${({ $size, theme }) => {
    const fontSizeMap = {
      xsm: theme.fontSize.xxSmall - 1,
      sm: theme.fontSize.xxSmall,
      md: theme.fontSize.xSmall,
      lg: theme.fontSize.small,
    };
    return fontSizeMap[$size];
  }}px;
  font-family: ${({ theme }) => theme.fontFamily.poppinsMedium};
`;