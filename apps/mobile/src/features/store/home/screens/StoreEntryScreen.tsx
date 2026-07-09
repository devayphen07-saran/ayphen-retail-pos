import { useEffect, useRef, useState } from 'react';
import { router } from 'expo-router';
import { Column, Typography, Button } from '@ayphen/mobile-ui-components';
import { useAuth } from '@core/providers/AuthProvider';
import { useAuthStore } from '@store';
import { useEnterStore } from '../../shared/hooks/useEnterStore';
import { BootstrapLoader } from '@ui/BootstrapLoader';

interface Props {
  storeId: string;
}

/**
 * Store opened. The snapshot proves this ACCOUNT has access to `storeId`
 * (mobile-03 §4 step 5), but says nothing about whether THIS DEVICE has a
 * slot on it (device-management §7 F2) — those are different checks, and
 * conflating them let a device over the store's plan limit navigate straight
 * into the store before this fix. `useEnterStore` claims the slot first;
 * only a successful claim proceeds to `setActiveStore` + navigation.
 */
export function StoreEntryScreen({ storeId }: Props) {
  const { logout } = useAuth();
  const { enterStore } = useEnterStore();
  const [notFound, setNotFound] = useState(false);
  const attemptedRef = useRef(false);

  useEffect(() => {
    if (attemptedRef.current) return;
    attemptedRef.current = true;

    // Same lookup store-picker.tsx does off the snapshot.
    const stores = useAuthStore.getState().snapshot?.stores ?? [];
    const store = stores.find((s) => s.store_id === storeId);

    if (!store) {
      setNotFound(true);
      return;
    }

    enterStore(store).then((entered) => {
      // Blocked (device limit, or gave up retrying) — don't strand the user
      // on a spinner forever; the picker is always a safe place to land.
      if (!entered) router.replace('/(app)/store-picker');
    });
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

  // Visible while the device-slot claim is in flight, and briefly after —
  // this now blocks on the claim's result instead of firing it in the
  // background after an unconditional navigate (see class doc).
  return <BootstrapLoader />;
}