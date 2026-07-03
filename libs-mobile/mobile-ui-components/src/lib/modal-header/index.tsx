import { useMobileTheme } from "@ayphen/mobile-theme";
import { ActivityIndicator } from "react-native";
import styled from "styled-components/native";
import { Row } from "../layout";
import { Typography } from "../typography";
import { Divider } from "../divider";
import React from "react";

type ModalHeaderProps = {
  title: string;
  leftText?: string;
  rightText?: string;
  onPressLeft?: () => void;
  onPressRight?: () => void;
  disableRight?: boolean;
  isLoading?: boolean;
};

export function ModalHeader({
  title,
  onPressLeft,
  onPressRight,
  rightText,
  leftText,
  disableRight,
  isLoading,
}: ModalHeaderProps) {
  const { theme } = useMobileTheme();
  const showRight = !!(rightText && onPressRight);

  return (
    <>
      <ModalRow
        justify="space-between"
        padding={"medium"}
        align="center"
      >
        {showRight ? (
          <>
            <LeftSideButton onPress={onPressLeft}>
              <ToggleText>{leftText ?? "Cancel"}</ToggleText>
            </LeftSideButton>
            <HeaderTitleContainer>
              <CenteredSubtitle weight={"bold"} numberOfLines={1} ellipsizeMode="tail">
                {title}
              </CenteredSubtitle>
            </HeaderTitleContainer>
            <RightSideButton
              onPress={!disableRight ? onPressRight : undefined}
              disabled={disableRight || isLoading}
            >
              {isLoading ? (
                <ActivityIndicator size="small" color={theme.colorPrimary} />
              ) : (
                <ToggleText $disabled={disableRight}>{rightText}</ToggleText>
              )}
            </RightSideButton>
          </>
        ) : (
          <>
            <Typography.Subtitle weight={"bold"}>{title}</Typography.Subtitle>

            <LeftSideButton onPress={onPressLeft}>
              <ToggleText>{leftText ?? "Cancel"}</ToggleText>
            </LeftSideButton>
          </>
        )}
      </ModalRow>
      <Divider marginVertical={0} thickness={0.5} />
    </>
  );
}

// ─── Styles ─────────────────────────────────────────────────────────────

const ModalRow = styled(Row)`
  background-color: ${({ theme }) => theme.colorBgContainer};
`;

// 60px = theme.sizing.xxLarge (48) + theme.sizing.small (12)
const LeftSideButton = styled.TouchableOpacity`
  width: ${({ theme }) => theme.sizing.xxLarge + theme.sizing.small}px;
  align-items: flex-start;
  justify-content: flex-start;
`;

const RightSideButton = styled.TouchableOpacity`
  width: ${({ theme }) => theme.sizing.xxLarge + theme.sizing.small}px;
  align-items: flex-end;
  justify-content: flex-end;
`;

const CenteredSubtitle = styled(Typography.Subtitle)`
  text-align: center;
`;

const ToggleText = styled.Text<{ $disabled?: boolean }>`
  font-size: ${({ theme }) => theme.fontSize.small}px;
  color: ${({ theme, $disabled }) =>
    $disabled ? theme.colorPrimaryBgHover : theme.colorPrimary};
`;

const HeaderTitleContainer = styled.View`
  flex: 1;
  align-items: center;
  justify-content: center;
`;
