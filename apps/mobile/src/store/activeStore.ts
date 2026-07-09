/**
 * Active-store context — the single source of truth for "which store is the
 * user currently inside" while they're in the (store) stack. Mirrors the
 * authStore pattern (Zustand, ephemeral, re-hydrated per launch); the durable
 * "last opened" pointer lives in storePrefs (AsyncStorage).
 *
 * The store's identity/permissions come from the account-level
 * PermissionSnapshot's `stores` entry — the snapshot is the only
 * client-side source of a store's shape until a dedicated "my stores"
 * endpoint exists (see store-picker.tsx's note).
 */
import { useMemo } from 'react';
import { create } from 'zustand';
import type { PermissionSnapshot } from '@ayphen/api-manager';
import { useAuthStore } from './authStore';

/** One entry of PermissionSnapshot.stores. */
export type StoreContext = PermissionSnapshot['stores'][number];

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

/**
 * The active store's context, DERIVED from the live permission snapshot by
 * `storeId` — so a store rename (which refreshes the snapshot) reflects
 * immediately, instead of the frozen copy taken at
 * enter-store time going stale (Commandment 5: no duplicated server data).
 * Falls back to that copy only until the snapshot carries the store (e.g. the
 * first render right after entering).
 */
export function useActiveStoreContext(): StoreContext | null {
  const storeId = useActiveStoreStore((s) => s.storeId);
  const fallback = useActiveStoreStore((s) => s.store);
  const snapshot = useAuthStore((s) => s.snapshot);
  return useMemo(() => {
    if (!storeId) return null;
    return snapshot?.stores.find((s) => s.store_id === storeId) ?? fallback;
  }, [storeId, snapshot, fallback]);
}
