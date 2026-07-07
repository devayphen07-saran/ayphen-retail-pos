import { useCallback, useState } from 'react';
import { router, type Href } from 'expo-router';
import { Alert, useBottomSheet } from '@ayphen/mobile-ui-components';
import {
  DeviceLimitRecoverySheet,
  type DeviceLimitRecoverySheetProps,
} from '@features/store/devices';
import { useClaimStoreAccessMutation, type NormalizedError } from '@ayphen/api-manager';
import { useActiveStoreStore, useAuthStore, type StoreContext } from '@store';

// Guard-level codes this endpoint's TenantGuard/SubscriptionStatusGuard can
// throw before claimSlot ever runs — the backend's mechanically-humanized
// text ("Store context missing", "Subscription reconciliation required") is
// accurate but reads as internal plumbing; give the ones a store-opening
// owner/staff member can actually hit a plain-language equivalent.
const KNOWN_ACCESS_MESSAGES: Record<string, string> = {
  subscription_suspended: 'This account is suspended. Contact your account owner.',
  subscription_payment_required: 'Payment is due on this account before you can continue.',
  subscription_reconciliation_required:
    "This account's plan change needs to be resolved before opening this store.",
  store_locked: 'This store is locked. Contact your account owner.',
};

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
  const sheet = useBottomSheet();
  const [checking, setChecking] = useState(false);

  /** Returns whether the store was actually entered — callers that reach
   *  this store directly (not via the picker) need to know so they can
   *  navigate somewhere sane on a block, rather than sitting on a spinner
   *  forever. */
  const enterStore = useCallback(
    async (store: StoreContext, opts?: { isRetryAfterFree?: boolean }): Promise<boolean> => {
      setChecking(true);
      try {
        await claimAccess.mutateAsync({ pathParam: { storeId: store.store_id } });
        setActiveStore(store);
        // `replace`, never `push` — this is a store-state transition
        // (navigation-agent.md §5). Resume the deep-linked sub-route the
        // (store)/_layout stashed on its picker bounce, else the store home.
        const target = useAuthStore.getState().consumePendingStoreRoute();
        router.replace(target ? (target as Href) : '/(store)');
        return true;
      } catch (err) {
        const code = (err as { code?: string } | undefined)?.code;
        if (code === 'device_limit_reached') {
          // A retry right after freeing a slot that STILL hits the limit means
          // someone else claimed it first (or nothing was actually freed) —
          // don't reopen the interactive sheet a second time and risk a loop,
          // just fall back to the static message.
          if (opts?.isRetryAfterFree) {
            Alert.info(
              'Device limit reached',
              "This store's plan doesn't allow another device. Ask the store owner to " +
                'free up a device slot (Store Settings > Devices), or upgrade the plan.',
            );
          } else {
            sheet.open<DeviceLimitRecoverySheetProps>({
              snapPoint: 'md',
              title: 'Device limit reached',
              closeOnBackdrop: true,
              Component: DeviceLimitRecoverySheet,
              props: {
                storeId: store.store_id,
                onFreed: () => enterStore(store, { isRetryAfterFree: true }),
              },
            });
          }
        } else {
          const e = err as Partial<NormalizedError> | undefined;
          const message =
            (e?.code && KNOWN_ACCESS_MESSAGES[e.code]) ??
            e?.message ??
            'Could not verify access to this store.';
          Alert.confirm('Store access issue', message, () => enterStore(store), 'Retry');
        }
        return false;
      } finally {
        setChecking(false);
      }
    },
    [claimAccess, setActiveStore, sheet],
  );

  // Lets the OverlayLoader's post-timeout "Cancel" escape the wait client-side
  // if the claim call hangs — the in-flight request isn't aborted, but its
  // `finally` above is idempotent, so this can't leave `checking` stuck true.
  const cancelChecking = useCallback(() => setChecking(false), []);

  return { enterStore, checking, cancelChecking };
}