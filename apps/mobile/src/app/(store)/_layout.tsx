import { useEffect } from 'react';
import { Redirect, Stack, usePathname } from 'expo-router';
import { useMobileTheme } from '@ayphen/mobile-theme';
import { Alert } from '@ayphen/mobile-ui-components';
import { useActiveStoreStore, useAuthStore } from '@store';
import { AuthGate } from '@core/auth/AuthGate';
import { useCanAccessStore } from '@core/auth/usePermission';
import { useStoreOpenStatus } from '@core/sync/store-open-status';
import { StoreOpenGate } from '@features/store/shared/components/StoreOpenGate';

/**
 * Store stack — the in-store experience. Reachable only when authenticated AND
 * a store has been selected into the active-store context (via store-picker).
 * No active store → bounce to the store picker so we never render a store
 * screen without a store to render it for.
 *
 * The real `<Stack>` (and every data screen inside it) only mounts once the
 * store-open state machine reports `ready` FOR THIS storeId — otherwise a
 * screen could `useLiveQuery` against SQLite before migrations/cold start
 * finish (navigation-agent.md §4, golden rule 8).
 */
export default function StoreLayout() {
  const { theme } = useMobileTheme();
  const storeId = useActiveStoreStore((s) => s.storeId);
  const openStatus = useStoreOpenStatus();
  const pathname = usePathname();
  const setPendingStoreRoute = useAuthStore((s) => s.setPendingStoreRoute);
  // Re-evaluates on every snapshot refresh — a user whose entire role in this
  // store is revoked mid-session must be bounced out of the store shell, not
  // just out of the individual `RequirePermission`-gated screens.
  const canAccess = useCanAccessStore(storeId ?? '');

  // Deep link / cold start into a (store) route with no active store yet:
  // remember the intended sub-route so the store-enter flow can resume there
  // instead of dropping the user on the store home. Skip '/' (a bare (store)
  // entry) so a normal open never stashes a no-op.
  useEffect(() => {
    if (!storeId && pathname && pathname !== '/') setPendingStoreRoute(pathname);
  }, [storeId, pathname, setPendingStoreRoute]);

  useEffect(() => {
    if (storeId && !canAccess) {
      Alert.info("Access removed", "You no longer have access to this store.");
    }
  }, [storeId, canAccess]);

  if (!storeId) return <Redirect href="/(app)/store-picker" />;
  if (!canAccess) return <Redirect href="/(app)/store-picker" />;

  const isThisStoreReady = openStatus.storeId === storeId && openStatus.phase === 'ready';

  return (
    <AuthGate>
      {!isThisStoreReady ? (
        <StoreOpenGate
          storeId={storeId}
          phase={openStatus.storeId === storeId ? openStatus.phase : 'opening'}
          error={openStatus.storeId === storeId ? openStatus.error : null}
        />
      ) : (
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: theme.colorBgLayout },
          }}
        />
      )}
    </AuthGate>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from '@ui/RouteErrorBoundary';
