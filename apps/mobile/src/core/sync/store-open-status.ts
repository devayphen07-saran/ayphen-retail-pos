/**
 * Reactive readiness signal for the store-open state machine
 * (navigation-agent.md §4: RESOLVE→CLAIM_SLOT→OPEN_CONTEXT→MIGRATE→
 * COLD_START?→DELTA→READY). `scheduler-instance.ts` is the only writer;
 * `(store)/_layout.tsx` is the primary reader — it must not mount the real
 * navigator until `phase === 'ready'` for the CURRENT `storeId` (INV-5: no
 * screen may query SQLite before migrations/cold-start finish).
 *
 * Every setter is a no-op if the passed `storeId` doesn't match the state's
 * current `storeId` — guards against a stale async callback from a
 * superseded store switch overwriting the new store's status.
 */
import { create } from 'zustand';

export type StoreOpenPhase = 'idle' | 'opening' | 'ready' | 'error';

interface StoreOpenStatusState {
  storeId: string | null;
  phase: StoreOpenPhase;
  error: string | null;
  setOpening: (storeId: string) => void;
  setReady: (storeId: string) => void;
  setError: (storeId: string, message: string) => void;
  reset: () => void;
}

export const useStoreOpenStatus = create<StoreOpenStatusState>((set, get) => ({
  storeId: null,
  phase: 'idle',
  error: null,

  setOpening: (storeId) => set({ storeId, phase: 'opening', error: null }),
  setReady: (storeId) => {
    if (get().storeId !== storeId) return;
    set({ phase: 'ready', error: null });
  },
  setError: (storeId, message) => {
    if (get().storeId !== storeId) return;
    set({ phase: 'error', error: message });
  },
  reset: () => set({ storeId: null, phase: 'idle', error: null }),
}));
