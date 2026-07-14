/**
 * POS cart — the single source of truth for the in-progress sale.
 *
 * Lifted out of PosScreen's local state so the cart survives navigation: the
 * grid (which adds items) and the dedicated `/(store)/cart` route (which reviews
 * and charges them) both read and mutate the same lines.
 *
 * Persisted to AsyncStorage so a half-rung cart survives an app kill / OS
 * reclaim mid-sale. Nothing here is committed data — it is discarded on the next
 * successful sale or a store switch.
 *
 * The cart is scoped to one store. `bindStore` clears it whenever the active
 * store changes, so products from one store can never be charged under another.
 * Because hydration from disk is asynchronous, callers must only `bindStore`
 * once `usePosCartStore.persist.hasHydrated()` is true — otherwise a persisted
 * cart from another store could be restored on top of a fresh bind.
 */
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { LocalCustomer } from '@core/sync/repositories/customer.repository';
import type { CartLine } from '../types/cart';

interface PosCartState {
  /** The store this cart belongs to; null before the first bind. */
  storeId: string | null;
  lines: CartLine[];
  selectedCustomer?: LocalCustomer;

  /** Point the cart at a store, clearing it if the store changed. */
  bindStore: (storeId: string) => void;
  /** Add one unit of a product (price already validated by the caller). */
  addProduct: (line: Omit<CartLine, 'qty'>) => void;
  changeQty: (productId: string, qty: number) => void;
  removeLine: (productId: string) => void;
  setSelectedCustomer: (customer?: LocalCustomer) => void;
  /** Empty the cart and drop the selected customer (used after a sale). */
  clear: () => void;
}

export const usePosCartStore = create<PosCartState>()(
  persist(
    (set) => ({
      storeId: null,
      lines: [],
      selectedCustomer: undefined,

      bindStore: (storeId) =>
        set((state) =>
          state.storeId === storeId
            ? state
            : { storeId, lines: [], selectedCustomer: undefined },
        ),

  addProduct: (line) =>
    set((state) => {
      const existing = state.lines.find((l) => l.productId === line.productId);

      if (existing) {
        const nextQty = existing.qty + 1;
        if (!Number.isSafeInteger(nextQty)) return state;

        return {
          lines: state.lines.map((l) =>
            l.productId === line.productId ? { ...l, qty: nextQty } : l,
          ),
        };
      }

      return { lines: [...state.lines, { ...line, qty: 1 }] };
    }),

  changeQty: (productId, qty) =>
    set((state) => {
      if (!Number.isSafeInteger(qty) || qty <= 0) {
        return { lines: state.lines.filter((l) => l.productId !== productId) };
      }

      return {
        lines: state.lines.map((l) =>
          l.productId === productId ? { ...l, qty } : l,
        ),
      };
    }),

  removeLine: (productId) =>
    set((state) => ({
      lines: state.lines.filter((l) => l.productId !== productId),
    })),

  setSelectedCustomer: (selectedCustomer) => set({ selectedCustomer }),

  clear: () => set({ lines: [], selectedCustomer: undefined }),
    }),
    {
      name: 'pos-cart',
      version: 1,
      storage: createJSONStorage(() => AsyncStorage),
      // Persist only the cart data — never the action functions.
      partialize: (state) => ({
        storeId: state.storeId,
        lines: state.lines,
        selectedCustomer: state.selectedCustomer,
      }),
    },
  ),
);
