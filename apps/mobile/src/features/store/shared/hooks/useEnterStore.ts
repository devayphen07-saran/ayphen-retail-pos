import { useCallback, useState } from 'react';
import { router } from 'expo-router';
import { Alert } from '@ayphen/mobile-ui-components';
import { useClaimStoreAccessMutation } from '@ayphen/api-manager';
import { useActiveStoreStore, type StoreContext } from '@store';

/**
 * Claim this device's store-access slot (device-management §7 F2) and only
 * THEN enter the store. Both StorePickerScreen and StoreEntryScreen must
 * gate navigation on this — a device over the store's plan limit
 * (`403 device_limit_reached`, F3) must never actually reach the store's
 * screens, regardless of what the account-level snapshot's store list says
 * (that list is membership, not slot availability).
 */
export function useEnterStore() {
  const claimAccess = useClaimStoreAccessMutation();
  const setActiveStore = useActiveStoreStore((s) => s.setActiveStore);
  const [checking, setChecking] = useState(false);

  /** Returns whether the store was actually entered — callers that reach
   *  this store directly (not via the picker) need to know so they can
   *  navigate somewhere sane on a block, rather than sitting on a spinner
   *  forever. */
  const enterStore = useCallback(
    async (store: StoreContext): Promise<boolean> => {
      setChecking(true);
      try {
        await claimAccess.mutateAsync({ pathParam: { storeId: store.store_id } });
        setActiveStore(store);
        // `replace`, never `push` — this is a store-state transition
        // (navigation-agent.md §5).
        router.replace('/(store)');
        return true;
      } catch (err) {
        const code = (err as { code?: string } | undefined)?.code;
        if (code === 'device_limit_reached') {
          Alert.info(
            'Device limit reached',
            "This store's plan doesn't allow another device. Ask the store owner to " +
              'free up a device slot (Store Settings > Devices), or upgrade the plan.',
          );
        } else {
          Alert.confirm(
            'Store access issue',
            (err as { message?: string } | undefined)?.message ??
              'Could not verify access to this store.',
            () => enterStore(store),
            'Retry',
          );
        }
        return false;
      } finally {
        setChecking(false);
      }
    },
    [claimAccess, setActiveStore],
  );

  return { enterStore, checking };
}