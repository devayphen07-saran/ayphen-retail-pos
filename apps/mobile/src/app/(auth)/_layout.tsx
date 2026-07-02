import { Redirect, Stack } from 'expo-router';
import { useAuthStore } from '../../auth/authStore';

/** Auth stack — only reachable when NOT authenticated. */
export default function AuthLayout() {
  const isAuthReady = useAuthStore((s) => s.isAuthReady);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  if (!isAuthReady) return null; // splash still showing
  if (isAuthenticated) return <Redirect href="/(app)" />;

  return <Stack screenOptions={{ headerShown: false }} />;
}
