import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useMobileTheme } from '@ayphen/mobile-theme';

// Matches BootstrapLoader / app.json's expo-splash-screen config so this
// screen reads as a continuation of the splash, not a new place.
const SPLASH_BACKGROUND_COLOR = '#ffffff';

interface ConnectionGateScreenProps {
  /** Re-attempt the failed startup step (session restore or bootstrap). */
  onRetry: () => Promise<void> | void;
  /** Escape hatch — ends the session locally so the user is never trapped
   *  on this screen (e.g. handing the device to someone else). Optional:
   *  omit where logout makes no sense. */
  onLogout?: () => Promise<void> | void;
  title?: string;
  message?: string;
}

/**
 * Shown when launch restore or bootstrap failed for a TRANSIENT reason
 * (offline, backend unreachable). The session tokens are intact — this screen
 * exists precisely so we do NOT log the user out over network weather
 * (flow-critic Phase 1). Definitive auth rejections never land here; they
 * clear tokens and route to login instead.
 */
export function ConnectionGateScreen({
  onRetry,
  onLogout,
  title = "Can't connect",
  message = 'Check your internet connection and try again.',
}: ConnectionGateScreenProps) {
  const { theme } = useMobileTheme();
  const [busy, setBusy] = useState(false);

  const handleRetry = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onRetry();
    } finally {
      setBusy(false);
    }
  }, [busy, onRetry]);

  return (
    <View style={styles.container}>
      <Image
        source={require('../../assets/images/splash-icon.png')}
        style={styles.logo}
        resizeMode="contain"
      />
      <Text style={[styles.title, { color: theme.colorText }]}>{title}</Text>
      <Text style={[styles.message, { color: theme.colorTextSecondary }]}>{message}</Text>

      <Pressable
        accessibilityRole="button"
        disabled={busy}
        onPress={handleRetry}
        style={({ pressed }) => [
          styles.retryButton,
          { backgroundColor: pressed || busy ? theme.colorPrimaryActive : theme.colorPrimary },
        ]}
      >
        {busy ? (
          <ActivityIndicator color="#ffffff" />
        ) : (
          <Text style={styles.retryLabel}>Retry</Text>
        )}
      </Pressable>

      {onLogout ? (
        <Pressable
          accessibilityRole="button"
          disabled={busy}
          onPress={onLogout}
          style={styles.logoutButton}
        >
          <Text style={[styles.logoutLabel, { color: theme.colorTextTertiary }]}>Log out</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: SPLASH_BACKGROUND_COLOR,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  logo: {
    width: 140,
    height: 140,
  },
  title: {
    marginTop: 24,
    fontSize: 18,
    fontFamily: 'Poppins-SemiBold',
  },
  message: {
    marginTop: 8,
    fontSize: 14,
    fontFamily: 'Poppins-Regular',
    textAlign: 'center',
  },
  retryButton: {
    marginTop: 24,
    minWidth: 160,
    height: 48,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  retryLabel: {
    color: '#ffffff',
    fontSize: 15,
    fontFamily: 'Poppins-Medium',
  },
  logoutButton: {
    marginTop: 20,
    padding: 8,
  },
  logoutLabel: {
    fontSize: 13,
    fontFamily: 'Poppins-Regular',
  },
});
