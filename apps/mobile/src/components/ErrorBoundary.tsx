import React, { type ReactNode, type ErrorInfo } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import * as SplashScreen from 'expo-splash-screen';

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
    console.error('[ErrorBoundary]', error, info.componentStack);
    // A crash during boot (before RootNavigator hides the splash) would leave
    // the native splash covering this fallback — a stuck splash. Dismiss it so
    // the recoverable error UI is actually visible. Safe to call if already hidden.
    void SplashScreen.hideAsync().catch(() => undefined);
  }

  reset = () => this.setState({ hasError: false, error: null });

  override render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <View style={styles.container}>
          <Text style={styles.title}>Something went wrong</Text>
          {this.state.error?.message ? (
            <Text style={styles.message}>{this.state.error.message}</Text>
          ) : null}
          <TouchableOpacity style={styles.button} onPress={this.reset}>
            <Text style={styles.buttonText}>Try Again</Text>
          </TouchableOpacity>
        </View>
      );
    }
    return this.props.children;
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
    backgroundColor: '#fff',
  },
  title: {
    fontSize: 18,
    fontFamily: 'Poppins-SemiBold',
    color: '#111',
    marginBottom: 8,
  },
  message: {
    fontSize: 13,
    fontFamily: 'Poppins-Regular',
    color: '#666',
    textAlign: 'center',
    marginBottom: 24,
  },
  button: {
    paddingHorizontal: 24,
    paddingVertical: 12,
    backgroundColor: '#111',
    borderRadius: 8,
  },
  buttonText: {
    fontFamily: 'Poppins-Medium',
    fontSize: 14,
    color: '#fff',
  },
});
