import { ActivityIndicator, Image, StyleSheet, View } from 'react-native';
import { useMobileTheme } from '@ayphen/mobile-theme';

// Matches app.json's expo-splash-screen config (backgroundColor + image) so
// this JS fallback reads as a continuation of the native splash rather than
// a distinct loading screen — keep the two in sync if either changes.
const SPLASH_BACKGROUND_COLOR = '#ffffff';

/** Splash-matching full-screen loader for bootstrap gaps the native splash can't cover (e.g. mid-session re-login). */
export function BootstrapLoader() {
  const { theme } = useMobileTheme();

  return (
    <View style={styles.container}>
      <Image
        source={require('../../assets/images/splash-icon.png')}
        style={styles.logo}
        resizeMode="contain"
      />
      <ActivityIndicator
        color={theme.colorTextSecondary}
        style={styles.spinner}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: SPLASH_BACKGROUND_COLOR,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logo: {
    width: 200,
    height: 200,
  },
  spinner: {
    marginTop: 24,
  },
});
