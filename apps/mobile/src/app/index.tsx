import { Redirect } from 'expo-router';
import { useAuthStore } from '@features/auth/authStore';

/** Entry gate — routes to the app or the auth stack once the session resolves. */
export default function Index() {
  const isAuthReady = useAuthStore((s) => s.isAuthReady);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  if (!isAuthReady) return null; // splash still visible
  return <Redirect href={isAuthenticated ? '/(app)' : '/(auth)/phone'} />;
}
 