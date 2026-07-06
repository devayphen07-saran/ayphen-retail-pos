import { useMemo } from 'react';
import { ScrollView } from 'react-native';
import { useMobileTheme } from '@ayphen/mobile-theme';
import { AppLayout, Column, ListRow, OverlayLoader } from '@ayphen/mobile-ui-components';
import { useAuthStore, type StoreContext } from '@store';
import { setLastOpenedStoreId } from '../../shared/utils/prefs';
import { useEnterStore } from '../../shared/hooks/useEnterStore';

/**
 * More than one accessible store and no remembered "last opened" — ask which
 * one to open (mobile-03 §4: "no pointer & >1 store → STORE PICKER, don't
 * auto-pick stores[0]").
 *
 * The snapshot's `storeLocations` entries carry the store `name` and its
 * locations (auth/types.ts PermissionSnapshot), so each row shows the store
 * name + location count — never the raw store id.
 */
export function StorePickerScreen() {
  const { theme } = useMobileTheme();
  const snapshot = useAuthStore((s) => s.snapshot);
  const { enterStore, checking } = useEnterStore();
  const storeLocations = useMemo(() => snapshot?.storeLocations ?? [], [snapshot]);

  const openStore = async (store: StoreContext) => {
    // A tap fires a network device-slot claim (below). Ignore further taps
    // while one is in flight so the user can't kick off two claims — the
    // OverlayLoader also blocks the UI to make the wait visible.
    if (checking) return;
    await setLastOpenedStoreId(store.store_id);
    // Claims (or is refused, e.g. device_limit_reached) this device's slot
    // BEFORE entering the store — being in the account's store list doesn't
    // mean this device has a slot (device-management §7 F2).
    await enterStore(store);
  };

  return (
    <AppLayout title="Choose a store">
      <ScrollView contentContainerStyle={{ padding: theme.sizing.large, flexGrow: 1 }}>
        <Column gap={4}>
          {storeLocations.map((store) => {
            const count = store.locations?.length ?? 0;
            return (
              <ListRow
                key={store.store_id}
                icon="Store"
                title={store.name || 'Unnamed store'}
                subtitle={`${count} location${count === 1 ? '' : 's'}`}
                onPress={() => openStore(store)}
              />
            );
          })}
        </Column>
      </ScrollView>
      {/* The slot claim is a network round-trip with no other on-screen
          feedback — block the UI so the tap doesn't read as a no-op and the
          store can't be double-entered (loading-agent.md §3). */}
      <OverlayLoader visible={checking} message="Opening store…" />
    </AppLayout>
  );
}