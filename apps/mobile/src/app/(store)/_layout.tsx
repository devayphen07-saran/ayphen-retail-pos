import { Redirect, Stack } from 'expo-router';
import { useMobileTheme } from '@ayphen/mobile-theme';
import { useAuthStore, useActiveStoreStore } from '@store';

/**
 * Store stack — the in-store experience. Reachable only when authenticated AND
 * a store has been selected into the active-store context (via store-picker).
 * No active store → bounce to the store picker so we never render a store
 * screen without a store to render it for.
 */
export default function StoreLayout() {
  const { theme } = useMobileTheme();
  const isAuthReady = useAuthStore((s) => s.isAuthReady);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const storeId = useActiveStoreStore((s) => s.storeId);

  if (!isAuthReady) return null; // splash still showing
  if (!isAuthenticated) return <Redirect href="/(auth)/phone" />;
  if (!storeId) return <Redirect href="/(app)/store-picker" />;

  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: theme.colorBgLayout },
      }}
    />
  );
}
