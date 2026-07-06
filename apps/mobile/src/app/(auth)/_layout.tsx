import { Redirect, Stack } from 'expo-router';
import { useMobileTheme } from '@ayphen/mobile-theme';
import { useAuthStore } from '@store';

/** Auth stack — only reachable when NOT authenticated. */
export default function AuthLayout() {
  const { theme } = useMobileTheme();
  const isAuthReady = useAuthStore((s) => s.isAuthReady);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  if (!isAuthReady) return null; // splash still showing
  if (isAuthenticated) return <Redirect href="/(app)" />;

  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: theme.colorBgLayout },
      }}
    />
  );
}
