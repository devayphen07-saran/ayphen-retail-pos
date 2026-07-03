import { useCallback, useEffect, useRef, useState } from 'react';
import { router } from 'expo-router';
import { Alert, Column, Typography, Button } from '@ayphen/mobile-ui-components';
import { useClaimStoreAccessMutation } from '@ayphen/api-manager';
import { useAuth } from '@core/providers/AuthProvider';
import { useAuthStore } from '@features/auth/authStore';
import { useActiveStoreStore } from '../activeStore';
import { BootstrapLoader } from '@ui/BootstrapLoader';

interface Props {
  storeId: string;
}

/**
 * Store opened. The snapshot already proves this account has access to
 * `storeId` (mobile-03 §4 step 5), so we enter the (store) stack immediately
 * off that cached data instead of blocking on a network call. `POST
 * /stores/:id/access` (device-slot heartbeat) still runs, but in the
 * background — it's idempotent and changes nothing the user sees on success,
 * so only a failure should interrupt (enterprise pattern: block navigation
 * only on data the screen truly can't render without).
 */
export function StoreEntryScreen({ storeId }: Props) {
  const { logout } = useAuth();
  const claimAccess = useClaimStoreAccessMutation();
  const setActiveStore = useActiveStoreStore((s) => s.setActiveStore);
  const [notFound, setNotFound] = useState(false);
  const attemptedRef = useRef(false);

  const claimInBackground = useCallback(() => {
    claimAccess.mutate(
      { pathParam: { storeId } },
      {
        onError: (err) => {
          // Already inside the store optimistically — a confirm dialog, not
          // a full-screen blocker, since the user isn't actually stuck.
          Alert.confirm(
            'Store access issue',
            err.message ?? 'Could not verify access to this store.',
            claimInBackground,
            'Retry',
          );
        },
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId]);

  useEffect(() => {
    if (attemptedRef.current) return;
    attemptedRef.current = true;

    // Same lookup store-picker.tsx does off the snapshot.
    const storeLocations = useAuthStore.getState().snapshot?.storeLocations ?? [];
    const store = storeLocations.find((s) => s.store_id === storeId);

    if (!store) {
      setNotFound(true);
      return;
    }

    setActiveStore(store);
    // `replace`, never `push` — this is a store-state transition
    // (navigation-agent.md §5).
    router.replace('/(store)');
    claimInBackground();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId]);

  if (notFound) {
    return (
      <Column flex={1} padding="large" gap="large" justify="center" align="center">
        <Typography.H2>Couldn't open this store</Typography.H2>
        <Typography.Body>This store isn't in your account anymore.</Typography.Body>
        <Button label="Log out" variant="default" onPress={logout} accessibilityLabel="Log out" />
      </Column>
    );
  }

  // Visible only for the single frame before the replace() above commits.
  return <BootstrapLoader />;
}