import React, { PropsWithChildren } from "react";
import { TouchableOpacity, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import styled from "styled-components/native";
import { ListPageHeader } from "./ListPageHeader";
import { LucideIcon, LucideIconNameType } from "../lucide-icon";
import { useMobileTheme } from "@ayphen/mobile-theme";

interface ListScaffoldProps {
  onPressLeft: () => void;
  rightIcon?: LucideIconNameType;
  onPressRight?: () => void;
  title: string;
  filterAndSearch: React.ReactNode;
}

export function ListPageScaffold({
  children,
  onPressLeft,
  onPressRight,
  rightIcon = "Plus",
  title,
  filterAndSearch,
}: PropsWithChildren<ListScaffoldProps>) {
  const insets = useSafeAreaInsets();
  const { theme } = useMobileTheme();

  return (
    <Container>
      {/* For Status bar spacing */}
      <StatusPadding style={{ height: insets.top }}></StatusPadding>
      <ListPageHeader
        title={title}
        leftElement={
          <TouchableOpacity onPress={onPressLeft}>
            <LucideIcon name={"ArrowLeft"} size={22} />
          </TouchableOpacity>
        }
        rightElement={
          onPressRight ? (
            <TouchableOpacity onPress={onPressRight}>
              <LucideIcon name={rightIcon} size={22} color={theme.colorPrimary} />
            </TouchableOpacity>
          ) : null
        }
      />
      <StickyContainer>{filterAndSearch}</StickyContainer>

      {children}
    </Container>
  );
}

export const SearchInputContainer = styled(View)`
  flex-direction: row;
  gap: ${({ theme }) => theme.sizing.xxSmall}px;
  background-color: ${({ theme }) => theme.colorBgContainer};
  bottom: 0;
`;

const StatusPadding = styled(View)`
  background-color: ${({ theme }) => theme.colorBgContainer};
`;

const Container = styled(View)`
  flex: 1;
  background-color: ${({ theme }) => theme.colorBgLayout};
`;

const StickyContainer = styled(View)`
  padding: ${({ theme }) => theme.padding.xSmall}px;
  padding-bottom: ${({ theme }) => theme.padding.medium}px;
  background-color: ${({ theme }) => theme.colorBgContainer};
`;
