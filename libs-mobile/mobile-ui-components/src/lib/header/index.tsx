import React from "react";
import { Platform, View, StyleProp, ViewStyle } from "react-native";
import styled, { css } from "styled-components/native";
import { Typography } from "../typography";
import { SafeAreaView } from "react-native-safe-area-context";

interface HeaderProps {
  title?: string;
  subtitle?: string;
  /** Replaces the title/subtitle block when provided. */
  centerElement?: React.ReactNode;
  leftElement?: React.ReactNode;
  rightElement?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}

export const Header: React.FC<HeaderProps> = ({
  title,
  subtitle,
  centerElement,
  leftElement,
  rightElement,
  style,
}) => {
  return (
    <HeaderSafe edges={["top"]} collapsable={false}>
      <HeaderContainer style={style}>
        <SideContainer>{leftElement}</SideContainer>
        <TitleBlock>
          {centerElement ? (
            centerElement
          ) : (
            <>
              <Title numberOfLines={1}>{title}</Title>
              {subtitle ? <Subtitle numberOfLines={1}>{subtitle}</Subtitle> : null}
            </>
          )}
        </TitleBlock>
        <SideContainer>{rightElement}</SideContainer>
      </HeaderContainer>
    </HeaderSafe>
  );
};

const HeaderSafe = styled(SafeAreaView)`
  background-color: ${({ theme }) => theme.colorBgContainer};
`;

const HeaderContainer = styled(View)`
  min-height: 64px;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  padding-left: ${({ theme }) => theme.padding.small}px;
  padding-right: ${({ theme }) => theme.padding.small}px;
  background-color: ${({ theme }) => theme.colorBgContainer};
  z-index: 10;
  ${Platform.select({
    ios: css`
      shadow-color: #000;
      shadow-opacity: 0.08;
      shadow-radius: 4px;
      shadow-offset: 0px 2px;
    `,
    android: css`
      elevation: 4;
    `,
  })}
`;

const TitleBlock = styled(View)`
  flex: 1;
  align-items: flex-start;
  justify-content: center;
`;

const Title = styled(Typography.H4)`
  text-align: left;
  color: ${({ theme }) => theme.colorText};
`;

const Subtitle = styled(Typography.Caption)`
  text-align: left;
  color: ${({ theme }) => theme.colorTextSecondary};
`;

const SideContainer = styled(View)`
  min-width: ${({ theme }) => theme.sizing.xLarge}px;
  align-items: center;
  justify-content: center;
`;
