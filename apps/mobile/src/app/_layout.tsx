import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MobileThemeProvider } from '@nks/mobile-theme';
import { AuthProvider } from '../providers/AuthProvider';
import { useAuthStore } from '../auth/authStore';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

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
  const isAuthReady = useAuthStore((s) => s.isAuthReady);

  useEffect(() => {
    if (fontsReady && isAuthReady) {
      SplashScreen.hideAsync();
    }
  }, [fontsReady, isAuthReady]);

  return <Stack screenOptions={{ headerShown: false }} />;
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
      <MobileThemeProvider>
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <RootNavigator fontsReady={fontsReady} />
          </AuthProvider>
        </QueryClientProvider>
      </MobileThemeProvider>
    </GestureHandlerRootView>
  );
}
