import { Redirect, Stack } from 'expo-router';
import { useMobileTheme } from '@ayphen/mobile-theme';
import { useAuthStore } from '@features/auth/authStore';

/**
 * Onboarding stack — authenticated but not yet routed into a store (mode
 * choice, store creation/join, pending invitations, personal workspace).
 * Deep-link defense in depth: a link landing straight in here must still be
 * bounced out if the session isn't authenticated (navigation-agent.md §3).
 */
export default function OnboardingLayout() {
  const { theme } = useMobileTheme();
  const isAuthReady = useAuthStore((s) => s.isAuthReady);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  if (!isAuthReady) return null; // splash still showing
  if (!isAuthenticated) return <Redirect href="/(auth)/phone" />;

  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: theme.colorBgLayout },
      }}
    />
  );
}
