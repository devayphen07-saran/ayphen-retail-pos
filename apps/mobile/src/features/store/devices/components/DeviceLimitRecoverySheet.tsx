import { useState } from 'react';
import { useMobileTheme } from '@ayphen/mobile-theme';
import {
  Alert,
  Column,
  SheetConfirmActions,
  SheetListItem,
  SheetSkeleton,
  Typography,
  useBottomSheet,
} from '@ayphen/mobile-ui-components';
import { useMyDevicesQuery, useBlockDeviceMutation } from '@ayphen/api-manager';
import type { MyDeviceResponse } from '@ayphen/api-manager';
import { timeAgo } from '../utils/time-ago';

export interface DeviceLimitRecoverySheetProps {
  storeId: string;
  /** Called once a slot has actually been freed — the caller retries entry. */
  onFreed: () => void;
}

/** Bottom-sheet content shown when store entry fails with `device_limit_reached`
 *  (flow-design decision, 2026-07-07). Lets the user free a slot by logging out
 *  one of their OWN other devices holding a slot in this store — reuses the
 *  same account-level block mutation as MyDevicesScreen (ownership is enforced
 *  server-side; this can never target another user's device). Freeing a slot
 *  held by someone ELSE's device is a separate, RBAC-gated capability that
 *  doesn't exist in mobile yet and is intentionally out of scope here. */
export function DeviceLimitRecoverySheet({ storeId, onFreed }: DeviceLimitRecoverySheetProps) {
  const { theme } = useMobileTheme();
  const sheet = useBottomSheet();
  const { data: devices, isLoading, isError, isFetching, refetch } = useMyDevicesQuery();
  const block = useBlockDeviceMutation();
  const [busyId, setBusyId] = useState<string | null>(null);

  const candidates = (devices ?? []).filter(
    (d) => d.store_ids.includes(storeId) && !d.is_current,
  );

  const runFree = async (device: MyDeviceResponse) => {
    setBusyId(device.device_id);
    try {
      await block.mutateAsync({ pathParam: { deviceId: device.device_id } });
      sheet.close();
      onFreed();
    } catch {
      Alert.info('Error', "Couldn't log out that device. Try again.");
    } finally {
      setBusyId(null);
    }
  };

  const confirmFree = (device: MyDeviceResponse) => {
    Alert.confirm(
      'Log out this device?',
      `${device.model ?? device.platform}\n\nThis will immediately: sign out all sessions ` +
        `· revoke access to all stores · prevent future login. Local data stays ` +
        `encrypted and cannot be accessed without your login credentials.`,
      () => runFree(device),
      'Log out device',
      'destructive',
    );
  };

  if (isLoading) {
    return <SheetSkeleton rows={2} />;
  }

  // A fetch failure at this exact moment (blocked from entering the store)
  // must not read as "you have no other devices to free" — that's a
  // different, misleading business-state message for what's actually a
  // network problem with an available retry.
  if (isError) {
    return (
      <Column gap={theme.sizing.medium} style={{ padding: theme.sizing.medium }}>
        <Typography.Body type="secondary">
          Couldn't load your devices. Check your connection and try again.
        </Typography.Body>
        <SheetConfirmActions
          confirmLabel={isFetching ? 'Retrying…' : 'Retry'}
          onConfirm={() => void refetch()}
          onCancel={() => sheet.close()}
        />
      </Column>
    );
  }

  if (candidates.length === 0) {
    return (
      <Column gap={theme.sizing.medium} style={{ padding: theme.sizing.medium }}>
        <Typography.Body type="secondary">
          This store's plan doesn't allow another device. Ask the store owner to free up a
          device slot (Store Settings {'>'} Devices), or upgrade the plan.
        </Typography.Body>
        <SheetConfirmActions
          confirmLabel="OK"
          onConfirm={() => sheet.close()}
          onCancel={() => sheet.close()}
        />
      </Column>
    );
  }

  return (
    <Column gap={theme.sizing.small} style={{ paddingVertical: theme.sizing.small }}>
      <Typography.Caption
        type="secondary"
        style={{ paddingHorizontal: theme.sizing.medium }}
      >
        These of your devices are using this store's device slots. Log one out to continue here.
      </Typography.Caption>
      {candidates.map((device) => (
        <SheetListItem
          key={device.device_id}
          label={device.model ?? device.platform}
          subtitle={`Last active ${timeAgo(device.last_seen_at)}`}
          icon="Smartphone"
          destructive
          disabled={busyId === device.device_id}
          disabledReason={busyId === device.device_id ? 'Logging out…' : undefined}
          onPress={() => confirmFree(device)}
        />
      ))}
    </Column>
  );
}