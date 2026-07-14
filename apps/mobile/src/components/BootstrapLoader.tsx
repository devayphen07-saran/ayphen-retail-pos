import { ActivityIndicator, Image } from 'react-native';
import styled from 'styled-components/native';
import { useMobileTheme } from '@ayphen/mobile-theme';

/** Splash-matching full-screen loader for bootstrap gaps the native splash can't cover (e.g. mid-session re-login). */
export function BootstrapLoader() {
  const { theme } = useMobileTheme();

  return (
    <Container>
      <Logo
        source={require('../../assets/images/splash-icon.png')}
        resizeMode="contain"
      />
      <Spinner color={theme.colorTextSecondary} />
    </Container>
  );
}

// Matches app.json's expo-splash-screen config (backgroundColor + image) so
// this JS fallback reads as a continuation of the native splash rather than
// a distinct loading screen — keep the two in sync if either changes.
const Container = styled.View`
  flex: 1;
  background-color: ${({ theme }) => theme.colorWhite};
  align-items: center;
  justify-content: center;
`;

// No theme.componentSizing token matches this splash-logo asset dimension —
// it's a fixed design-asset size, not a semantic spacing/sizing value.
const Logo = styled(Image)`
  width: 200px;
  height: 200px;
`;

const Spinner = styled(ActivityIndicator)`
  margin-top: ${({ theme }) => theme.sizing.large}px;
`;
