import { useMemo } from 'react';
import { ScrollView } from 'react-native';
import { router } from 'expo-router';
import { useMobileTheme } from '@ayphen/mobile-theme';
import { AppLayout, Column, ListRow } from '@ayphen/mobile-ui-components';
import { useAuthStore } from '@features/auth/authStore';
import { setLastOpenedStoreId } from '../prefs';
import { useActiveStoreStore, type StoreContext } from '../activeStore';

/**
 * More than one accessible store and no remembered "last opened" — ask which
 * one to open (mobile-03 §4: "no pointer & >1 store → STORE PICKER, don't
 * auto-pick stores[0]").
 *
 * Known limitation: the snapshot only carries `store_id` + locations, not the
 * store's display name (that's store-scoped data, intentionally kept out of
 * the account-level snapshot — mobile-01 §Scale note). Until a "my stores"
 * listing endpoint exists, this lists raw store ids.
 */
export function StorePickerScreen() {
  const { theme } = useMobileTheme();
  const snapshot = useAuthStore((s) => s.snapshot);
  const setActiveStore = useActiveStoreStore((s) => s.setActiveStore);
  const storeLocations = useMemo(() => snapshot?.storeLocations ?? [], [snapshot]);

  const openStore = async (store: StoreContext) => {
    await setLastOpenedStoreId(store.store_id);
    // Set the active-store context, then enter the (store) stack. The store
    // layout guards on this context, so it must be set before we navigate.
    setActiveStore(store);
    router.replace('/(store)');
  };

  return (
    <AppLayout title="Choose a store">
      <ScrollView contentContainerStyle={{ padding: theme.sizing.large, flexGrow: 1 }}>
        <Column gap={4}>
          {storeLocations.map((store) => (
            <ListRow
              key={store.store_id}
              icon="Store"
              title={store.store_id}
              onPress={() => openStore(store)}
            />
          ))}
        </Column>
      </ScrollView>
    </AppLayout>
  );
}