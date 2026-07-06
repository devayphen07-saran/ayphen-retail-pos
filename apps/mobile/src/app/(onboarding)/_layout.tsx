import { Stack } from 'expo-router';
import { useMobileTheme } from '@ayphen/mobile-theme';
import { AuthGate } from '@core/auth/AuthGate';

/**
 * Onboarding stack — authenticated but not yet routed into a store (mode
 * choice, store creation/join, pending invitations, personal workspace).
 * Deep-link defense in depth: a link landing straight in here must still be
 * bounced out if the session isn't authenticated (navigation-agent.md §3).
 */
export default function OnboardingLayout() {
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
