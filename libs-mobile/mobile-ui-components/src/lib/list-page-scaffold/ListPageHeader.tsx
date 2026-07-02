import React from "react";
import { TouchableOpacity, View } from "react-native";
import styled from "styled-components/native";
import { LucideIcon } from "../lucide-icon";
import { Typography } from "../typography";

export interface ListPageHeaderProps {
  rightElement?: React.ReactNode;
  leftElement?: React.ReactNode;
  onClickMenu?: () => void;
  title: string;
}

export function ListPageHeader({
  leftElement,
  rightElement,
  onClickMenu,
  title,
}: ListPageHeaderProps) {
  return (
    <HeaderContainer>
      <SideContainer>
        {!leftElement ? (
          <TouchableOpacity onPress={onClickMenu}>
            <LucideIcon name="Menu" size={20} />
          </TouchableOpacity>
        ) : (
          leftElement
        )}
      </SideContainer>
      <Typography.H5 numberOfLines={1}>{title}</Typography.H5>
      <SideContainer>{rightElement}</SideContainer>
    </HeaderContainer>
  );
}

const HeaderContainer = styled(View)`
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  padding-horizontal: ${({ theme }) => theme.padding.xSmall}px;
  padding-bottom: ${({ theme }) => theme.padding.xSmall}px;
  background-color: ${({ theme }) => theme.colorBgContainer};
`;

const SideContainer = styled(View)`
  min-width: ${({ theme }) => theme.sizing.xLarge}px;
  align-items: center;
  justify-content: center;
`;