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
import { FlatListLoading } from "./FlatListLoading";

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
  /**
   * Per-slot skeleton renderer shown while `loading` is true. When omitted,
   * falls back to a bare spinner — pass this so a first load matches the
   * "skeleton, not spinner" rule the rest of the list components follow.
   */
  loadingCard?: (index: number) => React.ReactNode;
  loaderLength?: number;
  buttonProps?: ActionButtonProps;
  /** Truthy when the underlying fetch failed. Takes priority over loading/empty. */
  error?: unknown;
  /** Shown in the error state; falls back to a generic message. */
  errorMessage?: string;
  /** Retry action for the error state's CTA. Required to show the error state. */
  onRetry?: () => void;
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
  loadingCard,
  loaderLength = 5,
  buttonProps,
  showBg = false,
  error,
  errorMessage,
  onRetry,
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

  // Highest priority: error. A fetch failure is otherwise indistinguishable
  // from a genuine empty list, and with no `error`/`onRetry` prop there was
  // no way to recover short of leaving and reopening.
  if (error) {
    return (
      <EmptyContainer accessibilityRole="alert" accessibilityLiveRegion="polite">
        <NoDataContainer
          message={errorMessage ?? "Something went wrong"}
          description="Check your connection and try again."
          iconName="CircleAlert"
          buttonProps={
            onRetry ? { buttonText: "Retry", onPress: onRetry, variant: "primary" } : undefined
          }
        />
      </EmptyContainer>
    );
  }

  if (loading) {
    if (loadingCard) {
      return <FlatListLoading loadingCard={loadingCard} length={loaderLength} />;
    }
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
