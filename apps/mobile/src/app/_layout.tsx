import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MobileThemeProvider, useMobileTheme } from '@ayphen/mobile-theme';
import { BottomSheetProvider } from '@ayphen/mobile-ui-components';
import { AuthProvider } from '@core/providers/AuthProvider';
import { useAuthStore } from '@features/auth/authStore';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { BootstrapLoader } from '../components/BootstrapLoader';

// Keep splash visible until fonts + auth state are ready
SplashScreen.preventAutoHideAsync();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 2,
      staleTime: 1000 * 60 * 5,   // 5 min
      gcTime:    1000 * 60 * 10,  // 10 min
    },
    mutations: {
      retry: 0,
    },
  },
});

/** Inner tree — hides the splash only once fonts AND the session have resolved. */
function RootNavigator({ fontsReady }: { fontsReady: boolean }) {
  const { theme } = useMobileTheme();
  const isAuthReady = useAuthStore((s) => s.isAuthReady);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const isBootstrapped = useAuthStore((s) => s.isBootstrapped);
  const isLastOpenedResolved = useAuthStore((s) => s.isLastOpenedResolved);
  // An authenticated launch routes through (app)/index.tsx's AppGate, which
  // needs both bootstrap AND the last-opened-store cache resolved before it
  // can redirect. Without waiting for both here too, the splash hides early
  // and the user sees AppGate's own loading fallback right after — hold the
  // splash through both instead (loading-agent.md §3: splash → real content,
  // zero intermediate states). Unauthenticated launches never set either, so
  // they're not blocked by them.
  const routingReady =
    isAuthReady && (!isAuthenticated || (isBootstrapped && isLastOpenedResolved));

  useEffect(() => {
    if (fontsReady && routingReady) {
      SplashScreen.hideAsync();
    }
  }, [fontsReady, routingReady]);

  return (
    <View style={{ flex: 1 }}>
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: theme.colorBgLayout },
        }}
      />
      {/* The native splash is only supposed to cover this whole gap, but its
          hide timing isn't perfectly reliable (esp. Android) — without this
          overlay, a native-splash hiding a beat early exposes a blank Stack
          with no screen resolved yet instead of a branded loader. */}
      {!routingReady && (
        <View style={StyleSheet.absoluteFill}>
          <BootstrapLoader />
        </View>
      )}
    </View>
  );
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    'Poppins-Thin':      require('../../assets/fonts/Poppins-Thin.ttf'),
    'Poppins-Light':     require('../../assets/fonts/Poppins-Light.ttf'),
    'Poppins-Regular':   require('../../assets/fonts/Poppins-Regular.ttf'),
    'Poppins-Medium':    require('../../assets/fonts/Poppins-Medium.ttf'),
    'Poppins-SemiBold':  require('../../assets/fonts/Poppins-SemiBold.ttf'),
    'Poppins-Bold':      require('../../assets/fonts/Poppins-Bold.ttf'),
    'Poppins-Italic':    require('../../assets/fonts/Poppins-Italic.ttf'),
  });

  const fontsReady = fontsLoaded || !!fontError;
  if (!fontsReady) return null;

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <MobileThemeProvider>
          <BottomSheetProvider>
            <QueryClientProvider client={queryClient}>
              <AuthProvider>
                <RootNavigator fontsReady={fontsReady} />
              </AuthProvider>
            </QueryClientProvider>
          </BottomSheetProvider>
        </MobileThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
