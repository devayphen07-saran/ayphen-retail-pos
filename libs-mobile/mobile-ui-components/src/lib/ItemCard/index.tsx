import React from "react";
import { View, Platform, StyleSheet } from "react-native";
import type { StyleProp, ViewStyle } from "react-native";
import styled, { useTheme, css } from "styled-components/native";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import type { ComponentProps } from "react";
import { ColorType, useColorVariant } from "@nks/mobile-theme";
import Avatar from "../avatar";
import { LucideIcon } from "../lucide-icon";
import { Typography } from "../typography";

type MaterialIconsProps = ComponentProps<typeof MaterialIcons>;

type ColoredIconProps = MaterialIconsProps & {
  color?: string; // Optional override
};

interface ItemCardProps {
  icon?: React.ReactNode;
  iconProps?: ColoredIconProps;
  content?: React.ReactNode;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
  title?: string;
  subtitle?: string;
  variant?: ColorType;
  avatarProps?: React.ComponentProps<typeof Avatar>;
  iconVariant?: ColorType;
  rightElement?: React.ReactNode;
  borderless?: boolean;
  marginBottom?: boolean;
}

export const ItemCard: React.FC<ItemCardProps> = ({
  content,
  onPress,
  style,
  title,
  subtitle,
  iconProps,
  variant = ColorType.default,
  iconVariant = ColorType.primary,
  avatarProps,
  rightElement,
  borderless = false,
  marginBottom = false,
}) => {
  const theme = useTheme();
  const colorVariant = useColorVariant({ place: "main" });
  return (
    <CardTouchable
      $variant={variant}
      $borderless={borderless}
      onPress={onPress}
      activeOpacity={0.85}
      style={{
        ...StyleSheet.flatten(style),
        marginBottom: marginBottom ? theme.padding.xxSmall : 0,
      }}
    >
      <IconWrapper>
        {iconProps && (
          <MaterialIcons {...iconProps} color={colorVariant[iconVariant]} />
        )}
        {avatarProps && <Avatar {...avatarProps} />}
      </IconWrapper>
      <ContentColumn>
        <Typography.Subtitle type="default" weight={"semiBold"}>
          {title}
        </Typography.Subtitle>
        {/* <TitleText $varient={varient}>{title}</TitleText> */}
        {subtitle && (
          <ContentWrapper>
            <Typography.Caption type="secondary">{subtitle}</Typography.Caption>
          </ContentWrapper>
        )}
        {content && <ContentWrapper>{content}</ContentWrapper>}
      </ContentColumn>
      <ArrowWrapper>
        {rightElement ? (
          rightElement
        ) : (
          <LucideIcon
            name="ChevronRight"
            size={24}
            color={theme.colorTextSecondary}
          />
        )}
      </ArrowWrapper>
    </CardTouchable>
  );
};

const CardTouchable = styled.TouchableOpacity<{
  $variant: ColorType;
  $borderless: boolean;
}>`
  border-width: ${({ theme, $borderless }) => ($borderless ? 0 : 1)}px;
  border-color: ${({ theme, $variant }) => theme.color[$variant].border};
  background-color: ${({ theme, $variant }) => theme.color[$variant].bg};

  flex-direction: row;
  align-items: center;
  padding: ${({ theme }) => theme.padding.regular}px;
  border-radius: ${({ theme }) => theme.borderRadius.large}px;

  ${({ $borderless, theme }) =>
    !$borderless &&
    Platform.select({
      ios: css`
        shadow-color: ${theme.colorText};
        shadow-opacity: 0.13;
        shadow-radius: 4px;
        shadow-offset: 0px 2px;
      `,
      android: css`
        elevation: 2;
      `,
    })}
`;

const IconWrapper = styled(View)`
  margin-right: 14px;
  align-items: center;
  justify-content: center;
`;

const ContentColumn = styled.View`
  flex: 1;
  justify-content: center;
`;

const ContentWrapper = styled.View`
  margin-top: 4px;
`;

const ArrowWrapper = styled(View)`
  margin-left: 10px;
  align-items: center;
  justify-content: center;
`;

export default ItemCard;
