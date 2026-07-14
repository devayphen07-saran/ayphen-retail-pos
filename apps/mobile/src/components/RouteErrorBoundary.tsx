import { useEffect } from 'react';
import { router } from 'expo-router';
import styled from 'styled-components/native';
import { useMobileTheme } from '@ayphen/mobile-theme';
import { Button, Column, LucideIcon, Typography } from '@ayphen/mobile-ui-components';
import { logger } from '../utils/logger';

export interface RouteErrorBoundaryProps {
  error: Error;
  retry: () => Promise<void>;
}

/**
 * Expo Router per-route error boundary (§6 "error boundaries per feature — one
 * crash ≠ white app"). Re-exported as `ErrorBoundary` from segment layouts and
 * the tab screens, so a render crash is CONTAINED to that segment — the rest of
 * the navigator (tab bar, sibling stacks) stays mounted — instead of the single
 * root boundary blanking the whole app and looping on "Try Again".
 *
 * Unlike the root class boundary, `retry` here is Expo Router's own segment
 * remount, and there's always an escape hatch to Home so a deterministically
 * crashing screen can't trap the user.
 */
export function RouteErrorBoundary({ error, retry }: RouteErrorBoundaryProps) {
  const { theme } = useMobileTheme();

  useEffect(() => {
    logger.error('[route] screen crashed', error);
  }, [error]);

  return (
    <Column
      flex={1}
      align="center"
      justify="center"
      padding={theme.sizing.large}
      gap={theme.sizing.medium}
      bg={theme.colorBgContainer}
    >
      <LucideIcon name="TriangleAlert" size={40} color={theme.colorError} />
      <Typography.H3 weight="bold">Something went wrong</Typography.H3>
      <CenteredBody type="secondary">
        This screen ran into a problem. You can try again, or head back to Home and return later.
      </CenteredBody>
      <ButtonStack gap={theme.sizing.small}>
        <Button label="Try again" onPress={() => void retry()} />
        <Button variant="text" label="Go to Home" onPress={() => router.replace('/(app)')} />
      </ButtonStack>
    </Column>
  );
}

// ─── Styles ───

const CenteredBody = styled(Typography.Body)`
  text-align: center;
`;

const ButtonStack = styled(Column)`
  align-self: stretch;
`;
