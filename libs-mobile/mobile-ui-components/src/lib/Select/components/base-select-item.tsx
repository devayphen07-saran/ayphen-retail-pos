import { Flex, Row } from "../../layout";
import { Typography } from "../../typography";
import Avatar from "../../avatar";
import { TouchableOpacity, TouchableOpacityProps } from "react-native";

import styled from "styled-components/native";
import { useMobileTheme } from "@ayphen/mobile-theme";
import { CheckIcon } from "lucide-react-native";
import { LucideIconNameType } from "../../lucide-icon";

interface BaseSelectItemProps extends TouchableOpacityProps {
  title: string | undefined;
  subTitle?: string | undefined;
  imageUrl?: string;
  isSelected: boolean;
  iconName?: LucideIconNameType;
  rightText?: string;
  titleTag?: string;
  disabled?: boolean;
}

export function BaseSelectItem(props: BaseSelectItemProps) {
  const {
    title,
    titleTag,
    disabled,
    subTitle,
    imageUrl,
    isSelected,
    rightText,
    iconName,
    ...touchProps
  } = props;

  const { theme } = useMobileTheme();
  const hasSubtitle = Boolean(subTitle && subTitle.trim() !== "");

  return (
    <BaseItemContainer
      $isSelected={isSelected}
      {...touchProps}
      disabled={disabled}
    >
      <Row padding={"xxSmall"} justify="space-between" align="center">
        <Row gap={"small"} align="center">
          <Avatar
            disabled={disabled}
            uri={imageUrl}
            initials={iconName ? undefined : title}
            iconName={iconName}
          />
          <InnerFlex $hasSubtitle={hasSubtitle}>
            <Row gap={"xxSmall"}>
              <Typography.Subtitle
                weight={"medium"}
                type={disabled ? "secondary" : "default"}
              >
                {title}
              </Typography.Subtitle>
              {titleTag && (
                <TagContainer>
                  <Typography.Overline
                    weight={"semiBold"}
                    type={disabled ? "secondary" : "default"}
                    color={theme.colorWhite}
                  >
                    {titleTag}
                  </Typography.Overline>
                </TagContainer>
              )}
            </Row>

            {hasSubtitle && <Typography.Caption>{subTitle}</Typography.Caption>}
          </InnerFlex>
        </Row>

        <Row gap={"small"} align="center">
          {rightText && (
            <Typography.H5 weight={"bold"} type="default">
              {rightText}
            </Typography.H5>
          )}
          {isSelected && <CheckIcon color={theme.colorPrimary} />}
        </Row>
      </Row>
    </BaseItemContainer>
  );
}

const TagContainer = styled.View`
  background-color: ${({ theme }) => theme.color.primary.text};
  border-radius: ${({ theme }) => theme.borderRadius.large}px;
  padding-vertical: 0px;
  padding-horizontal: ${({ theme }) => theme.sizing.xxSmall}px;
  height: 17px;
  align-items: center;
  justify-content: center;
`;

const InnerFlex = styled(Flex)<{ $hasSubtitle: boolean }>`
  justify-content: ${({ $hasSubtitle }) => ($hasSubtitle ? "flex-start" : "center")};
`;

const BaseItemContainer = styled(TouchableOpacity)<{ $isSelected: boolean }>`
  margin: ${({ theme }) => theme.sizing.xSmall}px;
  padding: ${({ theme }) =>
    `0px ${theme.sizing.large}px 0px ${theme.sizing.xSmall}px`};
  width: 100%;
  border-radius: ${({ theme }) => theme.borderRadius.medium}px;
`;
