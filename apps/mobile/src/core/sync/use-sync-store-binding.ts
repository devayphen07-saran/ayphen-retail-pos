import { useEffect } from 'react';
import { useActiveStoreStore } from '@store';
import { startSyncForStore, stopSync } from './scheduler-instance';

/**
 * Reactive binding: the sync scheduler follows `activeStoreStore.storeId`.
 * Mounted once near the app root (RootNavigator) rather than called from
 * every "enter store" / "leave store" / "logout" call site — those already
 * all funnel through `setActiveStore`/`clearActiveStore` (MoreScreen's logout
 * row clears the active store before calling `logout()`), so watching the
 * one piece of state here covers all of them for free.
 */
export function useSyncStoreBinding(): void {
  const storeId = useActiveStoreStore((s) => s.storeId);

  useEffect(() => {
    if (!storeId) {
      stopSync();
      return;
    }
    void startSyncForStore(storeId);
    return () => stopSync();
  }, [storeId]);
}
