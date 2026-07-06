import { Stack } from 'expo-router';
import { useMobileTheme } from '@ayphen/mobile-theme';
import { AuthGate } from '@core/auth/AuthGate';

/** Protected stack — only reachable when authenticated. */
export default function AppLayout() {
  const { theme } = useMobileTheme();

  return (
    <AuthGate>
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: theme.colorBgLayout },
        }}
      />
    </AuthGate>
  );
}
