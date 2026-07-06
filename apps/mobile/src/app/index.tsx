import { Redirect } from 'expo-router';
import { useAuthStore } from '@store';
import { useAuth } from '@core/providers/AuthProvider';
import { ConnectionGateScreen } from '@ui/ConnectionGateScreen';

/** Entry gate — routes to the app or the auth stack once the session resolves. */
export default function Index() {
  const isAuthReady = useAuthStore((s) => s.isAuthReady);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const restoreFailed = useAuthStore((s) => s.restoreFailed);
  const { retryRestore, logout } = useAuth();

  // Transient launch-restore failure (offline, backend down): tokens are
  // intact, so retry — never redirect to login, which reads as "logged out".
  if (restoreFailed) {
    return <ConnectionGateScreen onRetry={retryRestore} onLogout={logout} />;
  }

  if (!isAuthReady) return null; // splash still visible
  return <Redirect href={isAuthenticated ? '/(app)' : '/(auth)/phone'} />;
}
