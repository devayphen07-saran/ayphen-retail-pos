import { Redirect, Stack } from 'expo-router';
import { useMobileTheme } from '@ayphen/mobile-theme';
import { useActiveStoreStore } from '@store';
import { AuthGate } from '@core/auth/AuthGate';

/**
 * Store stack — the in-store experience. Reachable only when authenticated AND
 * a store has been selected into the active-store context (via store-picker).
 * No active store → bounce to the store picker so we never render a store
 * screen without a store to render it for.
 */
export default function StoreLayout() {
  const { theme } = useMobileTheme();
  const storeId = useActiveStoreStore((s) => s.storeId);

  return (
    <AuthGate>
      {!storeId ? (
        <Redirect href="/(app)/store-picker" />
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
