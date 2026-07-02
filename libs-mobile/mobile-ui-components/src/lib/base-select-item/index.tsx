import React from "react";
import { TouchableOpacity, TouchableOpacityProps, View } from "react-native";
import styled from "styled-components/native";
import { useMobileTheme } from "@nks/mobile-theme";
import { Avatar } from "../avatar";
import { Flex, Row } from "../layout";
import { Typography } from "../typography";
import { LucideIcon, LucideIconNameType } from "../lucide-icon";

export interface BaseSelectItemProps extends TouchableOpacityProps {
  title: string | undefined;
  subTitle?: string | undefined;
  imageUrl?: string;
  isSelected: boolean;
  iconName?: LucideIconNameType;
  rightText?: string;
  titleTag?: string;
  disabled?: boolean;
}

export const BaseSelectItem = (props: BaseSelectItemProps) => {
  const { theme } = useMobileTheme();
  const {
    title,
    titleTag,
    disabled = false,
    subTitle,
    imageUrl,
    isSelected,
    rightText,
    iconName,
    ...touchProps
  } = props;

  const hasSubtitle = Boolean(subTitle && subTitle.trim() !== "");

  return (
    <BaseItemContainer
      $isSelected={isSelected}
      {...touchProps}
      disabled={disabled}
      activeOpacity={0.7}
    >
      <Row padding={"xxSmall"} justify="space-between" align="center">
        <Row gap={"small"} align="center" style={{ flex: 1 }}>
          <Avatar
            uri={imageUrl}
            initials={iconName ? undefined : title}
            iconName={iconName}
            size={40}
          />
          <InnerFlex $hasSubtitle={hasSubtitle}>
            <Row gap={"xxSmall"} align="center">
              <Typography.Subtitle
                weight={"medium"}
                type={disabled ? "secondary" : "default"}
                numberOfLines={1}
                ellipsizeMode="tail"
              >
                {title}
              </Typography.Subtitle>
              {titleTag && (
                <TagContainer>
                  <Typography.Overline weight={"semiBold"} color={theme.colorWhite}>
                    {titleTag}
                  </Typography.Overline>
                </TagContainer>
              )}
            </Row>

            {hasSubtitle && (
              <Typography.Caption type="secondary" numberOfLines={1} ellipsizeMode="tail">
                {subTitle}
              </Typography.Caption>
            )}
          </InnerFlex>
        </Row>

        <Row gap={"small"} align="center">
          {rightText && (
            <Typography.H5 weight={"bold"} type="default">
              {rightText}
            </Typography.H5>
          )}
          {isSelected && <LucideIcon name="Check" color={theme.colorPrimary} size={20} />}
        </Row>
      </Row>
    </BaseItemContainer>
  );
};

const TagContainer = styled(View)`
  background-color: ${({ theme }) => theme.color.primary.text};
  border-radius: ${({ theme }) => theme.borderRadius.large}px;
  padding-horizontal: ${({ theme }) => theme.sizing.xxSmall}px;
  height: 17px;
  align-items: center;
  justify-content: center;
`;

const InnerFlex = styled(Flex)<{ $hasSubtitle: boolean }>`
  justify-content: ${({ $hasSubtitle }) => ($hasSubtitle ? "flex-start" : "center")};
  flex: 1;
`;

const BaseItemContainer = styled(TouchableOpacity)<{ $isSelected: boolean }>`
  margin: ${({ theme }) => theme.margin.xSmall}px;
  padding-vertical: ${({ theme }) => theme.padding.medium}px;
  padding-horizontal: ${({ theme }) => theme.padding.small}px;
  border-radius: ${({ theme }) => theme.borderRadius.medium}px;
  background-color: ${({ theme, $isSelected }) =>
    $isSelected ? theme.colorBgElevated : theme.colorBgContainer};
  border-width: ${({ theme }) => theme.borderWidth.thin}px;
  border-color: ${({ theme, $isSelected }) =>
    $isSelected ? theme.colorPrimary : theme.colorBorder};
`;
