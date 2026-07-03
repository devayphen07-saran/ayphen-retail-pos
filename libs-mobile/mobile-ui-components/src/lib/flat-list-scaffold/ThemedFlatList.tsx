import React from "react";
import {
  FlatList,
  FlatListProps,
  StyleProp,
  ActivityIndicator,
  ViewStyle,
} from "react-native";
import styled from "styled-components/native";
import { useMobileTheme } from "@ayphen/mobile-theme";
import { Divider } from "../divider";
import { LucideIconNameType } from "../lucide-icon";
import { NoDataContainer } from "./NoDataContainer";

interface ActionButtonProps {
  onPress: () => void;
  buttonText: string;
}

export interface ThemedFlatListProps<T> extends FlatListProps<T> {
  showDivider?: boolean;
  showBg?: boolean;
  dividerInsetLeft?: number;
  dividerInsetRight?: number;
  containerStyle?: StyleProp<ViewStyle>;
  EmptyComponentTitle?: string;
  EmptyComponentDescription?: string;
  EmptyComponentIcon?: LucideIconNameType;
  loading?: boolean;
  buttonProps?: ActionButtonProps;
}

export function ThemedFlatList<T>({
  data,
  renderItem,
  showDivider = false,
  dividerInsetLeft = 10,
  dividerInsetRight = 10,
  scrollEnabled = false,
  contentContainerStyle,
  containerStyle,
  ListEmptyComponent,
  EmptyComponentTitle = "No Data Found",
  EmptyComponentDescription = "Try adding new items",
  EmptyComponentIcon = "Inbox",
  loading = false,
  buttonProps,
  showBg = false,
  ...rest
}: ThemedFlatListProps<T>) {
  const { theme } = useMobileTheme();
  const isEmpty = !data || data.length === 0;

  const renderEmpty = () => (
    <EmptyContainer>
      {ListEmptyComponent ? (
        React.isValidElement(ListEmptyComponent) ? (
          ListEmptyComponent
        ) : (
          React.createElement(ListEmptyComponent as React.ComponentType<any>)
        )
      ) : (
        <NoDataContainer
          message={EmptyComponentTitle}
          description={EmptyComponentDescription}
          iconName={EmptyComponentIcon}
          buttonProps={buttonProps}
        />
      )}
    </EmptyContainer>
  );

  if (loading) {
    return (
      <LoadingContainer>
        <ActivityIndicator size="large" color={theme.colorPrimary} />
      </LoadingContainer>
    );
  }

  return (
    <FlatList
      style={[
        {
          marginHorizontal: theme.padding.xSmall,
          backgroundColor: isEmpty || !showBg ? "transparent" : theme.colorBgContainer,
          borderRadius: isEmpty ? 0 : theme.borderRadius.large,
          marginVertical: theme.padding.xSmall,
        },
        containerStyle,
      ]}
      data={data}
      scrollEnabled={scrollEnabled}
      ItemSeparatorComponent={
        showDivider
          ? () => (
              <Divider
                marginVertical={0}
                insetLeft={dividerInsetLeft}
                insetRight={dividerInsetRight}
              />
            )
          : undefined
      }
      contentContainerStyle={[
        {
          flexGrow: 1,
          justifyContent: data?.length ? "flex-start" : "center",
        },
        contentContainerStyle,
      ]}
      renderItem={renderItem}
      showsVerticalScrollIndicator={false}
      ListEmptyComponent={renderEmpty}
      {...rest}
    />
  );
}

// ─── Styles ─────────────────────────────────────────────────────────────

const EmptyContainer = styled.View`
  flex: 1;
  justify-content: center;
  align-items: center;
  padding-horizontal: ${({ theme }) => theme.sizing.medium}px;
  min-height: 300px;
`;

const LoadingContainer = styled.View`
  flex: 1;
  justify-content: center;
  align-items: center;
  padding: ${({ theme }) => theme.sizing.regular}px;
`;
