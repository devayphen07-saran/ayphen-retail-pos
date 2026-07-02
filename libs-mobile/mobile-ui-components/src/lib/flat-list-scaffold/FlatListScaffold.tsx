import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { RefreshControl, View, StyleSheet } from 'react-native';
import { FlashList, FlashListProps } from '@shopify/flash-list';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useMobileTheme } from '@nks/mobile-theme';

import Divider from '../divider';
import { LucideIconNameType } from '../lucide-icon';
import { NoDataContainer } from './NoDataContainer';
import { FlatListLoading } from './FlatListLoading';
import { DelayedRender } from './DelayedRender';
import { SearchBar, SearchBarProps } from './SearchBar';

const LOADING_DELAY_MS = 200;
const SLOW_NETWORK_MS = 10_000;

export interface SerializedError {
  name?: string;
  message?: string;
  stack?: string;
  code?: string;
}

export interface HttpListError {
  status: number;
  data?: { message?: string };
}

export type ListError = SerializedError | HttpListError;

export interface EmptyStateConfig {
  message: string;
  description?: string;
  icon?: LucideIconNameType;
  /** When true, the empty state reflects a filtered/searched view that returned no results. */
  filterActive?: boolean;
  /** Callback to clear filters; rendered as a CTA when `filterActive` is true. */
  onClearFilters?: () => void;
}

interface ListScaffoldProps<T> extends FlashListProps<T> {
  listProps: {
    error?: ListError;
    refetch: () => void;
    /** Optional add action; rendered as a CTA in the empty state when present and `filterActive` is false. */
    addNew?: () => void;
  };
  loaderProps: {
    isLoading: boolean;
    isFetching: boolean;
    /**
     * True only for user-initiated refreshes (pull-to-refresh, explicit refetch).
     * Drives the RefreshControl spinner. Pass React Query's `isRefetching` — NOT
     * `isFetching`, which fires on window-focus, mutation invalidation, and polling
     * and would surface a spurious spinner. If omitted, pull-to-refresh spinner is
     * disabled (safer than the wrong indicator).
     */
    isRefetching?: boolean;
    /** Factory called per skeleton slot so each can stagger its animation. */
    loadingCard: (index: number) => React.ReactNode;
    loaderLength: number;
  };
  emptyState?: EmptyStateConfig;
  errorState?: {
    message: string;
  };
  isThemed?: boolean;
  /** Passed through to FlashList. Defaults to 64 if omitted. */
  estimatedItemSize?: number;
  /**
   * When provided, renders a fixed search bar above the list (not inside the
   * scroll container). This keeps search visible regardless of scroll position
   * and allows the empty state to center correctly in the remaining height.
   */
  searchProps?: SearchBarProps;
}

// ─── Hoisted helpers (stable identity across renders) ───────────────────

const ThemedSeparator = () => (
  <Divider insetLeft={0} thickness={1} marginVertical={0} />
);
const SpacedSeparator = () => <View style={styles.spacedSeparator} />;

/**
 * Wraps content with an optional fixed SearchBar above. Extracted as a
 * sub-component so JSX structure is consistent across all state branches
 * (error, loading, normal) — prevents layout jumps when state changes.
 */
function SearchableContainer({
  searchProps,
  children,
}: {
  searchProps?: SearchBarProps;
  children: ReactNode;
}) {
  if (!searchProps) return <>{children}</>;
  return (
    <View style={styles.flex}>
      <SearchBar {...searchProps} />
      {children}
    </View>
  );
}

function getErrorDescription(error: ListError): string | undefined {
  // Narrow on `status` (required on HttpListError, absent on SerializedError).
  if ('status' in error) {
    return typeof error.data?.message === 'string'
      ? error.data.message
      : undefined;
  }
  return error.message;
}

function buildEmptyButtons(
  empty: EmptyStateConfig | undefined,
  addNew: (() => void) | undefined,
) {
  if (empty?.filterActive && empty.onClearFilters) {
    return [
      {
        buttonText: 'Clear Filters',
        onPress: empty.onClearFilters,
        variant: 'primary' as const,
      },
    ];
  }
  if (addNew) {
    return [
      { buttonText: 'Add New', onPress: addNew, variant: 'primary' as const },
    ];
  }
  return undefined;
}

// ─── Component ──────────────────────────────────────────────────────────

export function ListScaffold<T>({
  listProps,
  loaderProps,
  emptyState,
  errorState,
  isThemed,
  searchProps,
  ...restProps
}: ListScaffoldProps<T>) {
  const { theme } = useMobileTheme();
  const insets = useSafeAreaInsets();

  const { error, refetch, addNew } = listProps;
  const { isLoading, isFetching, isRefetching, loaderLength, loadingCard } =
    loaderProps;

  // ─── ALL HOOKS DECLARED FIRST, UNCONDITIONALLY ──────────────────────
  // React's Rules of Hooks: hooks must be called in the same order on every
  // render. Early-returning before a useState/useMemo/useEffect call causes
  // "Rendered more hooks than during previous render" crashes when state
  // transitions (loading → error → normal). Every hook lives above the
  // conditional return block.

  // Slow-network escalation. After SLOW_NETWORK_MS of continuous loading,
  // swap the skeleton for a "taking longer than usual" state with a retry
  // CTA so the user isn't staring at a spinner indefinitely.
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    if (!isLoading) {
      setSlow(false);
      return;
    }
    const t = setTimeout(() => setSlow(true), SLOW_NETWORK_MS);
    return () => clearTimeout(t);
  }, [isLoading]);

  // Style derived from theme + insets. Split into base (stable across data
  // changes) and bg (flips on empty/themed) so most renders reuse references.
  const baseStyle = useMemo(
    () => ({
      flexGrow: 1,
      paddingHorizontal: theme.padding.xSmall,
      paddingTop: theme.padding.xSmall,
      paddingBottom: insets.bottom + 10,
    }),
    [theme.padding.xSmall, insets.bottom],
  );

  const bgStyle = useMemo(
    () => ({
      backgroundColor: isThemed ? theme.colorBgContainer : theme.colorBgLayout,
    }),
    [isThemed, theme.colorBgContainer, theme.colorBgLayout],
  );

  // Wrap the [baseStyle, bgStyle] array in a memo so the reference stays
  // stable when neither piece changed. Without this, FlashList sees a fresh
  // array literal every render and re-evaluates contentContainer measurement.
  const contentContainerStyle = useMemo(
    () => [baseStyle, bgStyle],
    [baseStyle, bgStyle],
  );

  // RefreshControl creates a new element by default; memoize so FlashList's
  // refresh prop reference is stable when nothing changed.
  const refreshControl = useMemo(
    () => (
      <RefreshControl
        tintColor={theme.color.primary.main}
        colors={[theme.color.primary.main]}
        refreshing={isRefetching ?? false}
        onRefresh={refetch}
        accessibilityLabel="Pull to refresh"
      />
    ),
    [theme.color.primary.main, isRefetching, refetch],
  );

  // Empty component memoized properly — the JSX construction is INSIDE the
  // useMemo factory, not outside it. The earlier version computed JSX outside
  // and returned the same ref from inside, which never memoizes.
  const memoizedEmpty = useMemo(
    () => (
      <View
        style={styles.emptyContainer}
        accessibilityRole="text"
        accessibilityLabel={emptyState?.message ?? 'Nothing here yet'}
      >
        <NoDataContainer
          message={
            emptyState?.filterActive
              ? (emptyState?.message ?? 'No matches found')
              : (emptyState?.message ?? 'Nothing here yet')
          }
          description={
            emptyState?.filterActive
              ? (emptyState?.description ??
                'Try adjusting your filters or search.')
              : emptyState?.description
          }
          iconName={
            emptyState?.icon ??
            (emptyState?.filterActive ? 'Search' : 'Database')
          }
          buttonProps={buildEmptyButtons(emptyState, addNew)}
        />
      </View>
    ),
    [
      emptyState?.message,
      emptyState?.description,
      emptyState?.icon,
      emptyState?.filterActive,
      emptyState?.onClearFilters,
      addNew,
    ],
  );

  // Memoize the final FlashList props object so identity is stable when
  // none of the inputs changed.
  const scaffoldDefaults = useMemo(
    () => ({
      ListEmptyComponent: memoizedEmpty,
      refreshControl,
      ItemSeparatorComponent: isThemed ? ThemedSeparator : SpacedSeparator,
      contentContainerStyle,
      keyboardDismissMode: 'interactive' as const,
      showsVerticalScrollIndicator: false,
      // When SearchBar sits outside the list, FlashList needs flex: 1 to fill
      // the remaining height inside the SearchableContainer wrapper.
      ...(searchProps ? { style: styles.flex } : {}),
    }),
    [
      memoizedEmpty,
      refreshControl,
      contentContainerStyle,
      isThemed,
      searchProps,
    ],
  );

  // ─── Dev-only checks (after hooks, before render returns) ────────────

  if (
    process.env.NODE_ENV !== 'production' &&
    isRefetching === undefined &&
    isFetching
  ) {
    // eslint-disable-next-line no-console
    console.warn(
      'ListScaffold: loaderProps.isRefetching not provided. Pull-to-refresh ' +
        'is disabled to avoid showing a spinner for non-user-initiated refetches ' +
        "(window-focus, polling). Pass React Query's `isRefetching` to enable it.",
    );
  }

  // ─── State priority — early returns are safe now (no hooks below) ────

  // Highest priority: error. Keep error UI visible even during retry —
  // blanking the screen on retry feels broken; instead the button itself
  // shows the loading state via the `loading` flag.
  if (error) {
    return (
      <SearchableContainer searchProps={searchProps}>
        <View
          style={styles.errorContainer}
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
        >
          <NoDataContainer
            message={errorState?.message ?? 'Something went wrong'}
            description={getErrorDescription(error)}
            iconName="CircleAlert"
            buttonProps={[
              {
                buttonText: isFetching ? 'Retrying…' : 'Retry',
                onPress: refetch,
                variant: 'primary',
                disabled: isFetching,
                loading: isFetching,
              },
            ]}
          />
        </View>
      </SearchableContainer>
    );
  }

  // Slow-network escalation: after 10s of loading with no result, swap the
  // skeleton for an actionable "this is taking longer than usual" state.
  if (isLoading && slow) {
    return (
      <SearchableContainer searchProps={searchProps}>
        <View
          style={styles.errorContainer}
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
        >
          <NoDataContainer
            message="This is taking longer than usual"
            description="Check your connection and try again."
            iconName="WifiOff"
            buttonProps={[
              { buttonText: 'Try Again', onPress: refetch, variant: 'primary' },
            ]}
          />
        </View>
      </SearchableContainer>
    );
  }

  // Initial load: skeleton, delayed by LOADING_DELAY_MS to avoid the
  // flash-of-loading on queries that resolve under 200ms (warm cache, etc).
  if (isLoading) {
    return (
      <SearchableContainer searchProps={searchProps}>
        <DelayedRender delay={LOADING_DELAY_MS}>
          <FlatListLoading loadingCard={loadingCard} length={loaderLength} />
        </DelayedRender>
      </SearchableContainer>
    );
  }

  // Normal render — populated list, or empty state via ListEmptyComponent.
  return (
    <SearchableContainer searchProps={searchProps}>
      <FlashList {...restProps} {...scaffoldDefaults} />
    </SearchableContainer>
  );
}

// ─── Styles ─────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  errorContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  spacedSeparator: {
    height: 8,
  },
});
