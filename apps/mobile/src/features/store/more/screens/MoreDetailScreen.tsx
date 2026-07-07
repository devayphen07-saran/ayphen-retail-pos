import { router, useLocalSearchParams } from 'expo-router';
import { AppLayout, Column, Typography } from '@ayphen/mobile-ui-components';

type Params = { label: string; description?: string };

/** Shared placeholder destination for every More-menu item until its real feature ships. */
export function MoreDetailScreen() {
  const { label, description } = useLocalSearchParams<Params>();

  return (
    <AppLayout title={label ?? 'Coming soon'} onBack={() => router.back()}>
      <Column flex={1} justify="center" align="center" gap={4} padding="large">
        <Typography.H3>Coming soon</Typography.H3>
        {description ? <Typography.Body>{description}</Typography.Body> : null}
      </Column>
    </AppLayout>
  );
}