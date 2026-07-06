/**
 * Active-store context — the single source of truth for "which store is the
 * user currently inside" while they're in the (store) stack. Mirrors the
 * authStore pattern (Zustand, ephemeral, re-hydrated per launch); the durable
 * "last opened" pointer lives in storePrefs (AsyncStorage).
 *
 * The store's locations come from the account-level PermissionSnapshot's
 * `storeLocations` entry — the snapshot is the only client-side source of a
 * store's shape until a dedicated "my stores" endpoint exists (see
 * store-picker.tsx's note).
 */
import { create } from 'zustand';
import type { PermissionSnapshot } from '@ayphen/api-manager';

/** One entry of PermissionSnapshot.storeLocations. */
export type StoreContext = PermissionSnapshot['storeLocations'][number];

interface ActiveStoreState {
  /** null when no store is open (outside the (store) stack). */
  store: StoreContext | null;
  /** Convenience — the id of the open store, or null. */
  storeId: string | null;

  /** Enter a store: set it as the active context. */
  setActiveStore: (store: StoreContext) => void;
  /** Leave the store (back to the account/app stack). */
  clearActiveStore: () => void;
}

export const useActiveStoreStore = create<ActiveStoreState>((set) => ({
  store: null,
  storeId: null,

  setActiveStore: (store) => set({ store, storeId: store.store_id }),
  clearActiveStore: () => set({ store: null, storeId: null }),
}));
