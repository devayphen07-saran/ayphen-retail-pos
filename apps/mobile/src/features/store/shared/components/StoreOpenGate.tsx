import { ActivityIndicator } from 'react-native';
import { useMobileTheme } from '@ayphen/mobile-theme';
import { AppLayout, Button, Column, LucideIcon, Typography } from '@ayphen/mobile-ui-components';
import { startSyncForStore } from '@core/sync/scheduler-instance';
import type { StoreOpenPhase } from '@core/sync/store-open-status';

/**
 * The store-open state machine's visual gate (navigation-agent.md §4). Renders
 * while `phase !== 'ready'` so no data screen mounts before migrations/cold
 * start finish (golden rule 8) — `(store)/_layout.tsx` renders the real
 * `<Stack>` only once this returns null.
 */
export function StoreOpenGate({ storeId, phase, error }: { storeId: string; phase: StoreOpenPhase; error: string | null }) {
  const { theme } = useMobileTheme();

  if (phase === 'error') {
    return (
      <AppLayout title="Store">
        <Column gap={4} align="center" justify="center" flex={1} padding="large">
          <LucideIcon name="TriangleAlert" size={40} color={theme.color.danger.main} />
          <Typography.Body weight="semiBold">Couldn't open this store</Typography.Body>
          <Typography.Caption type="secondary">{error ?? 'Something went wrong while setting up your store.'}</Typography.Caption>
          <Button label="Retry" variant="default" onPress={() => void startSyncForStore(storeId)} />
        </Column>
      </AppLayout>
    );
  }

  return (
    <AppLayout title="Store">
      <Column gap={3} align="center" justify="center" flex={1}>
        <ActivityIndicator color={theme.colorPrimary} size="large" />
        <Typography.Body type="secondary">Setting up your store…</Typography.Body>
      </Column>
    </AppLayout>
  );
}
