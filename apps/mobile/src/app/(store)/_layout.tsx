import { Redirect, Stack } from 'expo-router';
import { useMobileTheme } from '@ayphen/mobile-theme';
import { useActiveStoreStore } from '@store';
import { AuthGate } from '@core/auth/AuthGate';
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

  if (!storeId) return <Redirect href="/(app)/store-picker" />;

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
