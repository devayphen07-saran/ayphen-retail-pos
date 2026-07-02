import { Redirect, Stack } from 'expo-router';
import { useAuthStore } from '../../auth/authStore';

/** Protected stack — only reachable when authenticated. */
export default function AppLayout() {
  const isAuthReady = useAuthStore((s) => s.isAuthReady);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  if (!isAuthReady) return null; // splash still showing
  if (!isAuthenticated) return <Redirect href="/(auth)/phone" />;

  return <Stack screenOptions={{ headerShown: false }} />;
}
