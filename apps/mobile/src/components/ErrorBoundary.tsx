import React, { type ReactNode, type ErrorInfo } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import * as SplashScreen from 'expo-splash-screen';
import { Alert } from '@ayphen/mobile-ui-components';
import { lightTheme } from '@ayphen/mobile-theme';
import { useAuthStore, useActiveStoreStore } from '@store';
import { clearTokens } from '@core/auth/token-store';
import { resetSubscriptionFreshness } from '@core/network/subscription-freshness';
import { resetPermissionFreshness } from '@core/network/permission-freshness';
import { logger } from '../utils/logger';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  override state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    logger.error(`[ErrorBoundary] ${info.componentStack ?? ''}`, error);
    // A crash during boot (before RootNavigator hides the splash) would leave
    // the native splash covering this fallback — a stuck splash. Dismiss it so
    // the recoverable error UI is actually visible. Safe to call if already hidden.
    void SplashScreen.hideAsync().catch(() => undefined);
  }

  reset = () => this.setState({ hasError: false, error: null });

  // "Try Again" just re-renders the same children — if the crash is caused by
  // corrupted/stale session state (not a transient render error), it loops
  // forever with no other way out. This clears exactly what a normal logout
  // clears (session store + tokens + freshness baselines, same as
  // AuthProvider's `logout()`) and re-renders, so a broken session can't
  // trap the user indefinitely.
  confirmResetAppData = () => {
    Alert.confirm(
      'Reset app data?',
      "This signs you out and clears your session on this device. Your account and data are safe — you'll just need to log in again.",
      () => void this.resetAppData(),
      'Reset app data',
      'destructive',
    );
  };

  resetAppData = async () => {
    try {
      await clearTokens();
    } catch (err) {
      logger.warn('[ErrorBoundary] clearTokens failed during reset', err as Error);
    }
    useAuthStore.getState().clear();
    useActiveStoreStore.getState().clearActiveStore();
    resetSubscriptionFreshness();
    resetPermissionFreshness();
    this.reset();
  };

  override render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <View style={styles.container}>
          <Text style={styles.title}>Something went wrong</Text>
          <Text style={styles.message}>
            Try again, or restart the app if it keeps happening.
          </Text>
          <TouchableOpacity style={styles.button} onPress={this.reset}>
            <Text style={styles.buttonText}>Try Again</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.secondaryButton} onPress={this.confirmResetAppData}>
            <Text style={styles.secondaryButtonText}>Reset app data</Text>
          </TouchableOpacity>
        </View>
      );
    }
    return this.props.children;
  }
}

// Mounted ABOVE MobileThemeProvider (see app/_layout.tsx) so it also catches a
// crash in the theme provider itself — `useMobileTheme()`/`Typography`/`Button`
// all need that provider's context and would throw if used here. `lightTheme`
// is the one theme export that's a plain object, not a hook/context, so it's
// the only safe way to still pull every value from the real design-system
// token set instead of hardcoding a second, drifting copy of the palette.
const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: lightTheme.sizing.large,
    backgroundColor: lightTheme.colorBgContainer,
  },
  title: {
    fontSize: lightTheme.fontSize.large,
    fontFamily: lightTheme.fontFamily.poppinsSemiBold,
    color: lightTheme.colorText,
    marginBottom: lightTheme.sizing.xSmall,
  },
  message: {
    fontSize: lightTheme.fontSize.small,
    fontFamily: lightTheme.fontFamily.poppinsRegular,
    color: lightTheme.colorTextSecondary,
    textAlign: 'center',
    marginBottom: lightTheme.sizing.large,
  },
  button: {
    paddingHorizontal: lightTheme.sizing.large,
    paddingVertical: lightTheme.sizing.small,
    backgroundColor: lightTheme.colorText,
    borderRadius: lightTheme.borderRadius.regular,
  },
  buttonText: {
    fontFamily: lightTheme.fontFamily.poppinsMedium,
    fontSize: lightTheme.fontSize.regular,
    color: lightTheme.colorWhite,
  },
  secondaryButton: {
    marginTop: lightTheme.sizing.small,
    paddingHorizontal: lightTheme.sizing.large,
    paddingVertical: lightTheme.sizing.small,
  },
  secondaryButtonText: {
    fontFamily: lightTheme.fontFamily.poppinsMedium,
    fontSize: lightTheme.fontSize.regular,
    color: lightTheme.colorError,
  },
});
