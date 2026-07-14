import { useCallback, useState } from 'react';
import { Image } from 'react-native';
import styled from 'styled-components/native';
import { Button, Column, Typography } from '@ayphen/mobile-ui-components';

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
    <Container align="center" justify="center">
      <Logo source={require('../../assets/images/splash-icon.png')} resizeMode="contain" />
      <Typography.H3 weight="semiBold" style={{ marginTop: 24 }}>
        {title}
      </Typography.H3>
      <Typography.Body type="secondary" style={{ marginTop: 8, textAlign: 'center' }}>
        {message}
      </Typography.Body>

      <ButtonStack>
        <Button label="Retry" onPress={() => void handleRetry()} loading={busy} size="lg" />
        {onLogout ? (
          <Button
            label="Log out"
            variant="text"
            disabled={busy}
            onPress={() => void onLogout()}
          />
        ) : null}
      </ButtonStack>
    </Container>
  );
}

// ─── Styles ───

// Matches BootstrapLoader / app.json's expo-splash-screen config so this
// screen reads as a continuation of the splash, not a new place.
const Container = styled(Column)`
  flex: 1;
  background-color: ${({ theme }) => theme.colorBgContainer};
  padding-left: ${({ theme }) => theme.sizing.xLarge}px;
  padding-right: ${({ theme }) => theme.sizing.xLarge}px;
`;

// No theme.componentSizing token matches this splash-logo asset dimension —
// it's a fixed design-asset size, not a semantic spacing/sizing value.
const Logo = styled(Image)`
  width: 140px;
  height: 140px;
`;

const ButtonStack = styled(Column)`
  align-self: stretch;
  margin-top: ${({ theme }) => theme.sizing.large}px;
  gap: ${({ theme }) => theme.sizing.small}px;
`;