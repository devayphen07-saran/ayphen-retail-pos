import type { ReactNode } from 'react';
import { Redirect } from 'expo-router';
import { useAuthStore } from '@store';

/**
 * Shared auth check for every protected route-group `_layout.tsx`
 * ((app), (onboarding), (store)): render nothing while the session is still
 * hydrating, bounce to the phone screen if unauthenticated, otherwise render
 * the stack. Group-specific gating (e.g. active-store presence) stays in the
 * calling layout and composes by nesting inside `children`.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const isAuthReady = useAuthStore((s) => s.isAuthReady);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  if (!isAuthReady) return null; // splash still showing
  if (!isAuthenticated) return <Redirect href="/(auth)/phone" />;

  return <>{children}</>;
}