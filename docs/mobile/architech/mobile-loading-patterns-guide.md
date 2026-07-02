# Mobile Loading Patterns — Complete Guide

> **Stack**: React Native · Expo Router · Redux Toolkit · styled-components/native · @nks/mobile-theme · @nks/mobile-ui-components
>
> This guide covers every type of loading state in a mobile app: what it is, when to use it, when NOT to use it, the full data flow, and production-ready component code following NKS library conventions.

---

## Table of Contents

1. [The Loading Decision Tree](#1-the-loading-decision-tree)
2. [Loading Type 1 — Skeleton / Shimmer](#2-loading-type-1--skeleton--shimmer)
3. [Loading Type 2 — Full Screen Spinner](#3-loading-type-2--full-screen-spinner)
4. [Loading Type 3 — Inline Button Spinner](#4-loading-type-3--inline-button-spinner)
5. [Loading Type 4 — Pull-to-Refresh](#5-loading-type-4--pull-to-refresh)
6. [Loading Type 5 — Pagination Footer](#6-loading-type-5--pagination-footer)
7. [Loading Type 6 — Overlay Blocker](#7-loading-type-6--overlay-blocker)
8. [Loading Type 7 — Optimistic (No Loading)](#8-loading-type-7--optimistic-no-loading)
9. [Loading Type 8 — Toast / Snackbar Progress](#9-loading-type-8--toast--snackbar-progress)
10. [Loading Type 9 — Progressive / Streamed Content](#10-loading-type-9--progressive--streamed-content)
11. [Screen State Machine](#11-screen-state-machine)
12. [Redux Integration Pattern](#12-redux-integration-pattern)
13. [Complete Screen Implementation](#13-complete-screen-implementation)
14. [Custom Hook — useScreenState](#14-custom-hook--usescreenstate)
15. [Component Creation Checklist](#15-component-creation-checklist)

---

## 1. The Loading Decision Tree

Before showing any loading indicator, run through this decision tree:

```
USER TRIGGERS AN ACTION
  │
  ├── Is there cached/local data to show RIGHT NOW?
  │     ├── YES → Show cached data + refresh silently in background
  │     │         (No loading indicator needed — maybe a subtle refresh indicator)
  │     │
  │     └── NO → What kind of content is loading?
  │               ├── A LIST → Skeleton shimmer (matches the list layout)
  │               ├── A DETAIL VIEW → Skeleton shimmer (matches the detail layout)
  │               ├── A FULL SCREEN → Full screen spinner (only if layout unknown)
  │               └── THE ENTIRE APP (boot) → Splash screen held
  │
  ├── Is the user performing a WRITE action? (create, update, delete, confirm)
  │     ├── Can it be OPTIMISTIC? (toggle, like, local-first write)
  │     │     └── YES → No loading. Update UI instantly. Sync in background.
  │     │
  │     ├── Is it DESTRUCTIVE? (delete, cancel, refund)
  │     │     └── Show confirmation dialog → then inline button spinner
  │     │
  │     ├── Is it CRITICAL and IRREVERSIBLE? (payment, transfer)
  │     │     └── Full overlay blocker ("Processing payment...")
  │     │
  │     └── Is it a STANDARD save/submit?
  │           └── Inline button spinner (disable button, show spinner in button)
  │
  ├── Is the user REFRESHING existing data?
  │     └── Pull-to-refresh (RefreshControl on ScrollView/FlatList)
  │
  ├── Is the user LOADING MORE items? (infinite scroll)
  │     └── Pagination footer spinner at the bottom of the list
  │
  └── Is the user SEARCHING or FILTERING?
        └── Inline spinner near the search bar or filter area
            (keep existing results visible until new results arrive)
```

### Quick Reference Table

| Scenario | Loading type | User sees | Duration |
|----------|-------------|-----------|----------|
| First visit, no cache | Skeleton shimmer | Layout placeholder matching final UI | 200ms–3s |
| Return visit, has cache | None (background refresh) | Cached data immediately | 0ms visible |
| Pull down to refresh | RefreshControl | Data + spinner at top | 500ms–3s |
| Scroll to load more | Pagination footer | Data + spinner at bottom | 200ms–2s |
| Tap save/confirm button | Inline button spinner | Button shows spinner, disabled | 200ms–5s |
| Tap delete with confirmation | Dialog → button spinner | Confirmation → spinner | 200ms–3s |
| Payment/critical action | Full overlay blocker | Dimmed screen + progress | 2s–30s |
| Toggle/like/offline write | Optimistic (none) | Instant change | 0ms |
| Search typing | Inline spinner | Results + small spinner | 300ms–2s |
| App boot | Splash screen held | Splash image | 50ms–500ms |
| Empty list | Empty state illustration | Friendly message + CTA | Permanent |
| API failure | Error state + retry | Error message + button | Permanent until retry |

---

## 2. Loading Type 1 — Skeleton / Shimmer

### When to use

- First visit to any screen that fetches data
- Screen where the layout shape is known in advance
- List screens (order list, product list, customer list)
- Detail screens (order detail, product detail)
- Dashboard with cards and stats

### When NOT to use

- Data is already cached (show the cache, refresh in background)
- The content shape is unpredictable
- The loading duration is under 100ms (feels like a flash — skip it)

### How it works — the full flow

```
SCREEN MOUNTS
  │
  ├── T+0ms   Component renders
  ├── T+1ms   useSelector(selectOrders) → Redux is empty (first visit)
  │           OR → Redux has stale data (show it, but also fetch fresh)
  ├── T+2ms   Render decision:
  │           ├── No data → Show <OrderListSkeleton />
  │           └── Has stale data → Show data + background fetch
  ├── T+3ms   dispatch(fetchOrders()) fires
  ├── T+3ms   Redux: orders.loading = true (from .pending handler)
  │
  │   ... network request in flight ...
  │
  ├── T+800ms API responds with data
  ├── T+801ms dispatch(ordersLoaded(data))
  ├── T+802ms Redux: orders.loading = false, orders.byId populated
  ├── T+803ms useSelector re-fires → component re-renders with real data
  └── T+804ms Skeleton replaced by actual content (no layout shift)
```

### Component — SkeletonBox (base primitive)

```tsx
// libs-mobile/mobile-ui-components/src/lib/skeleton-box/index.tsx

import React, { useEffect, useRef } from 'react';
import { Animated, ViewProps } from 'react-native';
import styled from 'styled-components/native';

// ─── Types ──────────────────────────────────────────────────────────────

interface SkeletonBoxProps extends ViewProps {
  width?: number | string;
  height?: number;
  borderRadius?: number;
  $fullWidth?: boolean;
}

// ─── Component ──────────────────────────────────────────────────────────

export const SkeletonBox: React.FC<SkeletonBoxProps> = ({
  width = '100%',
  height = 16,
  borderRadius = 6,
  $fullWidth = false,
  style,
  ...rest
}) => {
  const shimmerAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(shimmerAnim, {
          toValue: 1,
          duration: 1000,
          useNativeDriver: true,
        }),
        Animated.timing(shimmerAnim, {
          toValue: 0,
          duration: 1000,
          useNativeDriver: true,
        }),
      ]),
    );
    animation.start();
    return () => animation.stop();
  }, [shimmerAnim]);

  const opacity = shimmerAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0.3, 0.7],
  });

  return (
    <ShimmerBase
      as={Animated.View}
      style={[
        {
          width: $fullWidth ? '100%' : width,
          height,
          borderRadius,
          opacity,
        },
        style,
      ]}
      {...rest}
    />
  );
};

export default SkeletonBox;

// ─── Styles ─────────────────────────────────────────────────────────────

const ShimmerBase = styled.View`
  background-color: ${({ theme }) => theme.colorBorderSecondary};
`;
```

### Component — OrderListSkeleton (screen-specific)

Each screen's skeleton should match its actual layout so there is zero layout shift when real data loads.

```tsx
// apps/nks-mobile/src/features/orders/components/OrderListSkeleton.tsx

import React from 'react';
import styled from 'styled-components/native';
import { SkeletonBox } from '@nks/mobile-ui-components';
import { Row } from '@nks/mobile-ui-components';

// ─── Types ──────────────────────────────────────────────────────────────

interface OrderListSkeletonProps {
  count?: number;
}

// ─── Component ──────────────────────────────────────────────────────────

export const OrderListSkeleton: React.FC<OrderListSkeletonProps> = ({
  count = 6,
}) => {
  return (
    <Container>
      {Array.from({ length: count }).map((_, index) => (
        <CardSkeleton key={index}>
          <Row justify="space-between" align="center">
            <SkeletonBox width={120} height={16} borderRadius={4} />
            <SkeletonBox width={80} height={24} borderRadius={12} />
          </Row>
          <SkeletonBox width={180} height={14} borderRadius={4} />
          <Row justify="space-between" align="center">
            <SkeletonBox width={100} height={12} borderRadius={4} />
            <SkeletonBox width={70} height={16} borderRadius={4} />
          </Row>
        </CardSkeleton>
      ))}
    </Container>
  );
};

export default OrderListSkeleton;

// ─── Styles ─────────────────────────────────────────────────────────────

const Container = styled.View`
  padding: ${({ theme }) => theme.sizing.medium}px;
  gap: ${({ theme }) => theme.sizing.small}px;
`;

const CardSkeleton = styled.View`
  background-color: ${({ theme }) => theme.colorBgContainer};
  border-radius: ${({ theme }) => theme.borderRadius.regular}px;
  padding: ${({ theme }) => theme.sizing.medium}px;
  gap: ${({ theme }) => theme.sizing.small}px;
  border-width: ${({ theme }) => theme.borderWidth.thin}px;
  border-color: ${({ theme }) => theme.colorBorderSecondary};
`;
```

### The critical loading vs cache rule

```
SHOW SKELETON ONLY WHEN:
  orders.length === 0 AND isLoading === true

SHOW DATA + REFRESH INDICATOR WHEN:
  orders.length > 0 AND isLoading === true

SHOW DATA WHEN:
  orders.length > 0 AND isLoading === false

SHOW EMPTY STATE WHEN:
  orders.length === 0 AND isLoading === false AND isHydrated === true

NEVER:
  - Show skeleton when cached data exists (user sees a flash of empty)
  - Show skeleton after the first load (only on first visit)
  - Show skeleton forever (loading MUST resolve to success or error)
```

---

## 3. Loading Type 2 — Full Screen Spinner

### When to use

- App boot (while auth + hydration runs) — but prefer holding splash screen
- Navigating to a screen where layout shape is unknown
- Auth operations (login, logout, token refresh)

### When NOT to use

- List screens (use skeleton)
- Detail screens (use skeleton)
- Any screen where you know the layout
- Write operations (use button spinner or optimistic)

### Component — FullScreenLoader

```tsx
// libs-mobile/mobile-ui-components/src/lib/full-screen-loader/index.tsx

import React from 'react';
import { ActivityIndicator } from 'react-native';
import styled from 'styled-components/native';
import { useMobileTheme } from '@nks/mobile-theme';
import { Typography } from '../typography';

// ─── Types ──────────────────────────────────────────────────────────────

interface FullScreenLoaderProps {
  message?: string;
}

// ─── Component ──────────────────────────────────────────────────────────

export const FullScreenLoader: React.FC<FullScreenLoaderProps> = ({
  message,
}) => {
  const { theme } = useMobileTheme();

  return (
    <Container>
      <ActivityIndicator size="large" color={theme.colorPrimary} />
      {message && (
        <Typography.Body color={theme.colorTextSecondary}>
          {message}
        </Typography.Body>
      )}
    </Container>
  );
};

export default FullScreenLoader;

// ─── Styles ─────────────────────────────────────────────────────────────

const Container = styled.View`
  flex: 1;
  align-items: center;
  justify-content: center;
  background-color: ${({ theme }) => theme.colorBgLayout};
  gap: ${({ theme }) => theme.sizing.medium}px;
`;
```

### App boot — the right way

```tsx
// app/_layout.tsx
import * as SplashScreen from 'expo-splash-screen';

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    async function boot() {
      await initDatabase();
      restoreAuthFromMMKV();
      await hydrateReduxFromSQLite();
      setIsReady(true);
      await SplashScreen.hideAsync();
    }
    boot();
  }, []);

  if (!isReady) return null;

  return (
    <MobileThemeProvider>
      <Stack />
    </MobileThemeProvider>
  );
}
// User sees: Splash → real content (zero intermediate states)
```

---

## 4. Loading Type 3 — Inline Button Spinner

### When to use

- Save / submit form
- Confirm / approve action
- Status change (confirm order, mark delivered)
- Any button that triggers an API call

### When NOT to use

- Navigation buttons
- Optimistic actions (toggles, likes)
- Read operations (use skeleton or refresh indicator)

### Flow

```
USER TAPS "CONFIRM ORDER"
  │
  ├── T+0ms   Button: disabled=true, shows ActivityIndicator
  ├── T+1ms   dispatch(confirmOrder(orderId))
  │   ... API call ...
  ├── T+800ms SUCCESS → Button restores, status badge updates, toast shown
  └── T+800ms FAILURE → Button restores + enabled, error toast, Redux unchanged
```

### Component — AsyncButton

```tsx
// libs-mobile/mobile-ui-components/src/lib/async-button/index.tsx

import React, { useState, useCallback } from 'react';
import { ActivityIndicator } from 'react-native';
import styled from 'styled-components/native';
import { useMobileTheme } from '@nks/mobile-theme';

// ─── Types ──────────────────────────────────────────────────────────────

interface AsyncButtonProps {
  label: string;
  onPress: () => Promise<void> | void;
  variant?: 'primary' | 'default' | 'danger' | 'success';
  size?: 'small' | 'medium' | 'large';
  $fullWidth?: boolean;
  loading?: boolean;
  disabled?: boolean;
  icon?: React.ReactNode;
}

// ─── Component ──────────────────────────────────────────────────────────

export const AsyncButton: React.FC<AsyncButtonProps> = ({
  label,
  onPress,
  variant = 'primary',
  size = 'medium',
  $fullWidth = false,
  loading: externalLoading,
  disabled = false,
  icon,
}) => {
  const { theme } = useMobileTheme();
  const [internalLoading, setInternalLoading] = useState(false);

  const isLoading = externalLoading ?? internalLoading;
  const isDisabled = disabled || isLoading;

  const handlePress = useCallback(async () => {
    if (isDisabled) return;
    const result = onPress();
    if (result instanceof Promise) {
      setInternalLoading(true);
      try {
        await result;
      } finally {
        setInternalLoading(false);
      }
    }
  }, [onPress, isDisabled]);

  const spinnerColor =
    variant === 'default' ? theme.colorPrimary : theme.onColorPrimary;

  return (
    <ButtonContainer
      onPress={handlePress}
      activeOpacity={0.8}
      disabled={isDisabled}
      $variant={variant}
      $size={size}
      $fullWidth={$fullWidth}
      $isDisabled={isDisabled}
    >
      {isLoading ? (
        <ActivityIndicator size="small" color={spinnerColor} />
      ) : (
        <>
          {icon}
          <ButtonLabel $variant={variant} $size={size}>
            {label}
          </ButtonLabel>
        </>
      )}
    </ButtonContainer>
  );
};

export default AsyncButton;

// ─── Styles ─────────────────────────────────────────────────────────────

const ButtonContainer = styled.TouchableOpacity<{
  $variant: string;
  $size: string;
  $fullWidth: boolean;
  $isDisabled: boolean;
}>`
  flex-direction: row;
  align-items: center;
  justify-content: center;
  gap: ${({ theme }) => theme.sizing.xSmall}px;
  border-radius: ${({ theme }) => theme.borderRadius.regular}px;
  opacity: ${({ $isDisabled }) => ($isDisabled ? 0.5 : 1)};
  align-self: ${({ $fullWidth }) => ($fullWidth ? 'stretch' : 'flex-start')};
  padding-vertical: ${({ $size, theme }) =>
    $size === 'small'
      ? theme.sizing.xSmall
      : $size === 'large'
        ? theme.sizing.regular
        : theme.sizing.small}px;
  padding-horizontal: ${({ $size, theme }) =>
    $size === 'small'
      ? theme.sizing.small
      : $size === 'large'
        ? theme.sizing.large
        : theme.sizing.medium}px;
  background-color: ${({ $variant, theme }) =>
    $variant === 'primary'
      ? theme.color.primary.main
      : $variant === 'danger'
        ? theme.color.danger.main
        : $variant === 'success'
          ? theme.color.success.main
          : theme.colorBgContainer};
  border-width: ${({ $variant, theme }) =>
    $variant === 'default' ? theme.borderWidth.thin : 0}px;
  border-color: ${({ theme }) => theme.colorBorder};
`;

const ButtonLabel = styled.Text<{ $variant: string; $size: string }>`
  font-family: ${({ theme }) => theme.fontFamily.poppinsSemiBold};
  color: ${({ $variant, theme }) =>
    $variant === 'default' ? theme.colorText : theme.onColorPrimary};
  font-size: ${({ $size, theme }) =>
    $size === 'small'
      ? theme.fontSize.xSmall
      : $size === 'large'
        ? theme.fontSize.large
        : theme.fontSize.small}px;
`;
```

### Usage

```tsx
// Auto-tracking (Promise-based)
<AsyncButton
  label="Confirm Order"
  variant="success"
  $fullWidth
  onPress={async () => {
    await dispatch(confirmOrder(orderId)).unwrap();
    Toast.show({ type: 'success', text1: 'Order confirmed' });
  }}
/>

// External Redux loading
<AsyncButton
  label="Save"
  loading={isSaving}
  onPress={() => dispatch(updateOrder({ localId, changes: formData }))}
/>
```

---

## 5. Loading Type 4 — Pull-to-Refresh

### When to use

- Every list screen
- Detail screens with scrollable content
- Dashboard screens

### When NOT to use

- Form screens
- Modal/bottom sheet content (gesture conflicts)

### Implementation

```tsx
import { RefreshControl } from 'react-native';
import { useMobileTheme } from '@nks/mobile-theme';
import { ThemedFlatList } from '@nks/mobile-ui-components';

export default function OrderListScreen() {
  const { theme } = useMobileTheme();
  const [isRefreshing, setIsRefreshing] = useState(false);

  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    try {
      await dispatch(fetchOrders({ forceRefresh: true })).unwrap();
    } catch { /* toast error but DON'T clear the list */ }
    finally { setIsRefreshing(false); }
  }, [dispatch]);

  return (
    <ThemedFlatList
      data={orders}
      renderItem={({ item }) => <OrderCard order={item} />}
      keyExtractor={(item) => item.localId}
      refreshControl={
        <RefreshControl
          refreshing={isRefreshing}
          onRefresh={handleRefresh}
          tintColor={theme.colorPrimary}
          colors={[theme.colorPrimary]}
        />
      }
    />
  );
}
```

### Critical rule

Never clear the existing list when refreshing. The user's data remains visible. The spinner appears at the top above the content.

---

## 6. Loading Type 5 — Pagination Footer

### When to use

- Any list with more than 20 items
- Infinite scroll

### Component — PaginationFooter

```tsx
// libs-mobile/mobile-ui-components/src/lib/pagination-footer/index.tsx

import React from 'react';
import { ActivityIndicator } from 'react-native';
import styled from 'styled-components/native';
import { useMobileTheme } from '@nks/mobile-theme';
import { Typography } from '../typography';

// ─── Types ──────────────────────────────────────────────────────────────

interface PaginationFooterProps {
  isLoading: boolean;
  hasMore: boolean;
  itemCount: number;
}

// ─── Component ──────────────────────────────────────────────────────────

export const PaginationFooter: React.FC<PaginationFooterProps> = ({
  isLoading,
  hasMore,
  itemCount,
}) => {
  const { theme } = useMobileTheme();

  if (isLoading) {
    return (
      <Container>
        <ActivityIndicator size="small" color={theme.colorPrimary} />
        <Typography.Caption color={theme.colorTextSecondary}>
          Loading more...
        </Typography.Caption>
      </Container>
    );
  }

  if (!hasMore && itemCount > 0) {
    return (
      <Container>
        <Typography.Caption color={theme.colorTextSecondary}>
          You've seen all {itemCount} items
        </Typography.Caption>
      </Container>
    );
  }

  return null;
};

export default PaginationFooter;

// ─── Styles ─────────────────────────────────────────────────────────────

const Container = styled.View`
  padding: ${({ theme }) => theme.sizing.medium}px;
  align-items: center;
  justify-content: center;
  gap: ${({ theme }) => theme.sizing.xSmall}px;
`;
```

---

## 7. Loading Type 6 — Overlay Blocker

### When to use

- Payment processing
- File upload with progress
- Critical operations that MUST NOT be interrupted

### Component — OverlayLoader

```tsx
// libs-mobile/mobile-ui-components/src/lib/overlay-loader/index.tsx

import React from 'react';
import { ActivityIndicator, Modal } from 'react-native';
import styled from 'styled-components/native';
import { useMobileTheme } from '@nks/mobile-theme';
import { Typography } from '../typography';

// ─── Types ──────────────────────────────────────────────────────────────

interface OverlayLoaderProps {
  visible: boolean;
  message?: string;
  progress?: number;
}

// ─── Component ──────────────────────────────────────────────────────────

export const OverlayLoader: React.FC<OverlayLoaderProps> = ({
  visible,
  message = 'Processing...',
  progress,
}) => {
  const { theme } = useMobileTheme();

  return (
    <Modal transparent visible={visible} animationType="fade" statusBarTranslucent>
      <Backdrop>
        <LoaderCard>
          <ActivityIndicator size="large" color={theme.colorPrimary} />
          <Typography.Body weight="semiBold">{message}</Typography.Body>
          {progress !== undefined && (
            <ProgressBarContainer>
              <ProgressBarFill style={{ width: `${Math.min(progress, 100)}%` }} />
            </ProgressBarContainer>
          )}
          <Typography.Caption color={theme.colorTextSecondary}>
            Please don't close the app
          </Typography.Caption>
        </LoaderCard>
      </Backdrop>
    </Modal>
  );
};

export default OverlayLoader;

// ─── Styles ─────────────────────────────────────────────────────────────

const Backdrop = styled.View`
  flex: 1;
  align-items: center;
  justify-content: center;
  background-color: rgba(0, 0, 0, 0.5);
`;

const LoaderCard = styled.View`
  width: 280px;
  align-items: center;
  gap: ${({ theme }) => theme.sizing.medium}px;
  padding: ${({ theme }) => theme.sizing.large}px;
  background-color: ${({ theme }) => theme.colorBgContainer};
  border-radius: ${({ theme }) => theme.borderRadius.xLarge}px;
`;

const ProgressBarContainer = styled.View`
  width: 100%;
  height: 6px;
  border-radius: 3px;
  background-color: ${({ theme }) => theme.colorBorderSecondary};
  overflow: hidden;
`;

const ProgressBarFill = styled.View`
  height: 100%;
  border-radius: 3px;
  background-color: ${({ theme }) => theme.color.primary.main};
`;
```

---

## 8. Loading Type 7 — Optimistic (No Loading)

### When to use

- Toggle switch (notifications on/off)
- Like/favorite/bookmark
- Offline-first writes (create order, update product)

### The flow

```
USER TAPS "FAVORITE"
  ├── T+0ms   UI updates INSTANTLY (Redux optimistic update)
  ├── T+1ms   API call fires in background
  ├── T+500ms SUCCESS → do nothing (UI already correct)
  └── T+500ms FAILURE → ROLLBACK Redux + toast "Couldn't save"
```

### Implementation

```tsx
// Thunk with optimistic update + rollback
export const toggleFavorite = createAsyncThunk(
  'products/toggleFavorite',
  async (productId: string, { dispatch, getState, rejectWithValue }) => {
    // Optimistic update
    dispatch(productFavoriteToggled(productId));

    try {
      await api.post(`/api/v1/products/${productId}/favorite`);
    } catch (error) {
      // Rollback
      dispatch(productFavoriteToggled(productId));
      return rejectWithValue(error.message);
    }
  },
);
```

---

## 9. Loading Type 8 — Toast / Snackbar Progress

### When to use

- Background sync progress
- CSV export generation
- Bulk operations the user started but doesn't watch

```tsx
// Show progress
Toast.show({ type: 'info', text1: 'Syncing', text2: '5 of 12...', autoHide: false });

// Complete
Toast.show({ type: 'success', text1: 'All changes synced', autoHide: true, visibilityTime: 2000 });
```

---

## 10. Loading Type 9 — Progressive / Streamed Content

### When to use

- Dashboard with multiple independent data sources
- Each card/section loads independently

```tsx
export default function DashboardScreen() {
  const { data: revenue, isLoading: revLoading } = useQuery(['revenue'], fetchRevenue);
  const { data: orders, isLoading: ordLoading } = useQuery(['orderCount'], fetchOrderCount);

  return (
    <ScrollView>
      {revLoading ? <MetricCardSkeleton /> : <MetricCard title="Revenue" value={revenue} />}
      {ordLoading ? <MetricCardSkeleton /> : <MetricCard title="Orders" value={orders} />}
    </ScrollView>
  );
}
```

---

## 11. Screen State Machine

Every screen must handle these states:

```
  ┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐
  │ LOADING │    │ SUCCESS │    │  ERROR  │    │  EMPTY  │    │ OFFLINE │
  │(skeleton)│    │ (data)  │    │(retry)  │    │(CTA)    │    │(cache)  │
  └─────────┘    └─────────┘    └─────────┘    └─────────┘    └─────────┘
```

### Component — ScreenStateRenderer

```tsx
// libs-mobile/mobile-ui-components/src/lib/screen-state-renderer/index.tsx

import React from 'react';
import { NoDataContainer } from '../no-data-container';

// ─── Types ──────────────────────────────────────────────────────────────

interface ScreenStateRendererProps<T> {
  isLoading: boolean;
  isError: boolean;
  error?: string;
  data: T[] | T | null | undefined;
  skeleton: React.ReactNode;
  emptyTitle?: string;
  emptyDescription?: string;
  emptyAction?: { label: string; onPress: () => void };
  onRetry?: () => void;
  children: (data: NonNullable<T[] | T>) => React.ReactNode;
}

// ─── Component ──────────────────────────────────────────────────────────

export function ScreenStateRenderer<T>({
  isLoading,
  isError,
  error,
  data,
  skeleton,
  emptyTitle = 'Nothing here yet',
  emptyDescription,
  emptyAction,
  onRetry,
  children,
}: ScreenStateRendererProps<T>) {
  const hasData = Array.isArray(data) ? data.length > 0 : data != null;

  // Loading + no cache → skeleton
  if (isLoading && !hasData) return <>{skeleton}</>;

  // Error + no cache → error state
  if (isError && !hasData) {
    return <ErrorState message={error} onRetry={onRetry} />;
  }

  // No data, not loading → empty state
  if (!hasData && !isLoading) {
    return (
      <NoDataContainer
        title={emptyTitle}
        description={emptyDescription}
        actionLabel={emptyAction?.label}
        onAction={emptyAction?.onPress}
      />
    );
  }

  // Has data → render children
  return <>{children(data as NonNullable<T[] | T>)}</>;
}

export default ScreenStateRenderer;
```

### Component — ErrorState

```tsx
// libs-mobile/mobile-ui-components/src/lib/error-state/index.tsx

import React from 'react';
import styled from 'styled-components/native';
import { useMobileTheme } from '@nks/mobile-theme';
import { Typography } from '../typography';
import { Button } from '../button';
import { LucideIcon } from '../lucide-icon';

// ─── Types ──────────────────────────────────────────────────────────────

interface ErrorStateProps {
  message?: string;
  onRetry?: () => void;
}

// ─── Component ──────────────────────────────────────────────────────────

export const ErrorState: React.FC<ErrorStateProps> = ({
  message = 'Something went wrong',
  onRetry,
}) => {
  const { theme } = useMobileTheme();

  return (
    <Container>
      <LucideIcon name="AlertTriangle" size={48} color={theme.color.danger.main} />
      <Typography.Body weight="semiBold">Oops!</Typography.Body>
      <Typography.Caption color={theme.colorTextSecondary}>{message}</Typography.Caption>
      {onRetry && <Button type="default" onPress={onRetry}>Try Again</Button>}
    </Container>
  );
};

export default ErrorState;

// ─── Styles ─────────────────────────────────────────────────────────────

const Container = styled.View`
  flex: 1;
  align-items: center;
  justify-content: center;
  padding: ${({ theme }) => theme.sizing.xxLarge}px;
  gap: ${({ theme }) => theme.sizing.small}px;
`;
```

---

## 12. Redux Integration Pattern

### Slice with all loading states

```ts
interface OrdersState {
  byId: Record<string, Order>;
  allIds: string[];
  loading: boolean;                                  // screen-level
  error: string | null;
  hydrated: boolean;
  lastFetchedAt: number | null;
  paginationLoading: boolean;                        // load-more
  pagination: { page: number; limit: number; total: number; hasMore: boolean };
  entityActionLoading: Record<string, string | null>; // per-entity button spinners
}

// extraReducers
builder
  .addCase(fetchOrders.pending, (state) => {
    state.loading = true;
    state.error = null;
  })
  .addCase(fetchOrders.fulfilled, (state, action) => {
    state.loading = false;
    state.hydrated = true;
    state.lastFetchedAt = Date.now();
    // normalize data...
  })
  .addCase(fetchOrders.rejected, (state, action) => {
    state.loading = false;
    state.error = action.payload as string ?? 'Failed to load';
    // DON'T clear byId — keep cached data visible
  })

  .addCase(confirmOrder.pending, (state, action) => {
    state.entityActionLoading[action.meta.arg] = 'confirming';
  })
  .addCase(confirmOrder.fulfilled, (state, action) => {
    delete state.entityActionLoading[action.meta.arg];
    state.byId[action.meta.arg].status = 'confirmed';
  })
  .addCase(confirmOrder.rejected, (state, action) => {
    delete state.entityActionLoading[action.meta.arg];
  });
```

### Selectors

```ts
export const selectOrdersLoading = (s: RootState) => s.orders.loading;
export const selectOrdersError = (s: RootState) => s.orders.error !== null;
export const selectOrdersErrorMessage = (s: RootState) => s.orders.error;
export const selectPaginationLoading = (s: RootState) => s.orders.paginationLoading;
export const selectHasMore = (s: RootState) => s.orders.pagination.hasMore;

export const selectOrderActionLoading = (id: string) =>
  (s: RootState) => s.orders.entityActionLoading[id] ?? null;

export const selectOrdersList = createSelector(
  (s: RootState) => s.orders.byId,
  (s: RootState) => s.orders.allIds,
  (byId, allIds) => allIds.map((id) => byId[id]),
);
```

---

## 13. Complete Screen Implementation

All loading types combined in one production screen:

```tsx
import React, { useCallback, useState } from 'react';
import { RefreshControl } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { useMobileTheme } from '@nks/mobile-theme';
import {
  AppLayout, Header, SearchInput, ThemedFlatList,
  NoDataContainer, ScreenStateRenderer, PaginationFooter,
} from '@nks/mobile-ui-components';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import {
  fetchOrders, fetchOrdersNextPage,
  selectOrdersList, selectOrdersLoading, selectOrdersError,
  selectOrdersErrorMessage, selectPaginationLoading, selectHasMore,
} from '@/store/slices/ordersSlice';
import { OrderCard } from '../components/OrderCard';
import { OrderListSkeleton } from '../components/OrderListSkeleton';

export default function OrderListScreen() {
  const { theme } = useMobileTheme();
  const router = useRouter();
  const dispatch = useAppDispatch();

  const orders = useAppSelector(selectOrdersList);
  const isLoading = useAppSelector(selectOrdersLoading);
  const isError = useAppSelector(selectOrdersError);
  const errorMsg = useAppSelector(selectOrdersErrorMessage);
  const isPaginating = useAppSelector(selectPaginationLoading);
  const hasMore = useAppSelector(selectHasMore);

  const [search, setSearch] = useState('');
  const [isRefreshing, setIsRefreshing] = useState(false);

  useFocusEffect(useCallback(() => { dispatch(fetchOrders()); }, [dispatch]));

  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    try { await dispatch(fetchOrders({ force: true })).unwrap(); }
    catch { /* toast */ }
    finally { setIsRefreshing(false); }
  }, [dispatch]);

  const handleLoadMore = useCallback(() => {
    if (!isPaginating && hasMore) dispatch(fetchOrdersNextPage());
  }, [dispatch, isPaginating, hasMore]);

  const filtered = search
    ? orders.filter((o) => o.customerName.toLowerCase().includes(search.toLowerCase()))
    : orders;

  return (
    <AppLayout>
      <Header title="Orders" />
      <ScreenStateRenderer
        isLoading={isLoading} isError={isError} error={errorMsg} data={orders}
        skeleton={<OrderListSkeleton />}
        emptyTitle="No orders yet"
        emptyAction={{ label: 'Create Order', onPress: () => router.push('/orders/create') }}
        onRetry={() => dispatch(fetchOrders())}
      >
        {() => (
          <>
            <SearchInput value={search} onChangeText={setSearch} placeholder="Search orders..." />
            <ThemedFlatList
              data={filtered}
              renderItem={({ item }) => <OrderCard order={item} />}
              keyExtractor={(item) => item.localId}
              onEndReached={handleLoadMore}
              onEndReachedThreshold={0.5}
              refreshControl={
                <RefreshControl refreshing={isRefreshing} onRefresh={handleRefresh}
                  tintColor={theme.colorPrimary} colors={[theme.colorPrimary]} />
              }
              ListFooterComponent={
                <PaginationFooter isLoading={isPaginating} hasMore={hasMore} itemCount={filtered.length} />
              }
              ListEmptyComponent={
                search ? <NoDataContainer title="No results" description={`No orders match "${search}"`} /> : null
              }
            />
          </>
        )}
      </ScreenStateRenderer>
    </AppLayout>
  );
}
```

---

## 14. Custom Hook — useScreenState

```ts
import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { useAppDispatch } from '@/store/hooks';

interface UseScreenStateOptions {
  fetchAction: () => any;
  isLoading: boolean;
  isError: boolean;
  hasData: boolean;
}

export function useScreenState({ fetchAction, isLoading, isError, hasData }: UseScreenStateOptions) {
  const dispatch = useAppDispatch();
  const [isRefreshing, setIsRefreshing] = useState(false);

  useFocusEffect(useCallback(() => { dispatch(fetchAction()); }, [dispatch, fetchAction]));

  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    try { await dispatch(fetchAction()).unwrap(); }
    catch { /* handled by Redux */ }
    finally { setIsRefreshing(false); }
  }, [dispatch, fetchAction]);

  const handleRetry = useCallback(() => { dispatch(fetchAction()); }, [dispatch, fetchAction]);

  return {
    isRefreshing,
    handleRefresh,
    handleRetry,
    showSkeleton: isLoading && !hasData,
    showError: isError && !hasData,
    showEmpty: !isLoading && !isError && !hasData,
    showData: hasData,
    showRefreshIndicator: isRefreshing || (isLoading && hasData),
  };
}
```

### Usage

```tsx
export default function ProductListScreen() {
  const products = useAppSelector(selectProductsList);
  const isLoading = useAppSelector(selectProductsLoading);
  const isError = useAppSelector(selectProductsError);

  const { isRefreshing, handleRefresh, handleRetry, showSkeleton, showError, showEmpty } =
    useScreenState({ fetchAction: fetchProducts, isLoading, isError, hasData: products.length > 0 });

  if (showSkeleton) return <ProductListSkeleton />;
  if (showError) return <ErrorState onRetry={handleRetry} />;
  if (showEmpty) return <NoDataContainer title="No products" />;

  return (
    <FlatListScaffold
      data={products}
      renderItem={({ item }) => <ProductCard product={item} />}
      isRefreshing={isRefreshing}
      onRefresh={handleRefresh}
    />
  );
}
```

---

## 15. Component Creation Checklist

### NKS library rules

- [ ] File at `libs-mobile/mobile-ui-components/src/lib/<name>/index.tsx`
- [ ] styled-components use **template literal syntax**
- [ ] Styles placed **below** the component function
- [ ] All spacing from `theme.sizing.*`
- [ ] All colors from `theme.color.*` or `theme.colorXxx`
- [ ] All radii from `theme.borderRadius.*`
- [ ] All border widths from `theme.borderWidth.*`
- [ ] No hardcoded strings (`#fff`, `16px`)
- [ ] No inline `style={{ }}`
- [ ] Custom props are `$`-prefixed
- [ ] Exported from `libs-mobile/mobile-ui-components/src/index.ts`
- [ ] `ColorType.xxx` for variant props

### Loading-specific rules

- [ ] Loading always resolves to success OR error (never stuck)
- [ ] Skeleton matches actual screen layout
- [ ] Cached data shown immediately when available
- [ ] Pull-to-refresh keeps existing data visible
- [ ] Button spinners disable and replace label
- [ ] Errors show retry button
- [ ] Empty state shows message + CTA
- [ ] Offline shows cached data + banner
- [ ] Pagination footer shows "Loading more..."
- [ ] Optimistic updates revert on failure

---

*Last updated: June 2026 · NKS Design System v1.0 · Expo SDK 52+*
