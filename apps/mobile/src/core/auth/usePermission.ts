/**
 * Local UX gating over the cached permission snapshot — see permission-check.ts
 * for why this is not a security boundary. Re-renders only when the snapshot
 * or the active store changes (Zustand selectors), not on every store update.
 */
import { useMemo } from 'react';
import { useAuthStore } from '@store/authStore';
import { useActiveStoreStore } from '@store';
import { canAccessStore, hasPermission } from './permission-check';

/**
 * Gates on the CURRENTLY ACTIVE store — a user can hold different roles (and
 * therefore different grants) in different stores, so this must never fall
 * back to "any store" (that was the bug: Store A's grants leaking into
 * Store B's UI). No active store (storeId falsy) fails closed to `false`,
 * same as a missing/unloaded snapshot.
 */
export function usePermission(entity: string, action: string): boolean {
  const snapshot = useAuthStore((s) => s.snapshot);
  const storeId = useActiveStoreStore((s) => s.storeId);
  return useMemo(
    () => (storeId ? hasPermission(snapshot, storeId, entity, action) : false),
    [snapshot, storeId, entity, action],
  );
}

export function useCanAccessStore(storeId: string): boolean {
  const snapshot = useAuthStore((s) => s.snapshot);
  return useMemo(() => canAccessStore(snapshot, storeId), [snapshot, storeId]);
}
