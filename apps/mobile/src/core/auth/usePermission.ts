/**
 * Local UX gating over the cached permission snapshot — see permission-check.ts
 * for why this is not a security boundary. Re-renders only when the snapshot
 * itself changes (Zustand selector), not on every store update.
 */
import { useMemo } from 'react';
import { useAuthStore } from '@store/authStore';
import {
  canAccessStore,
  getDefaultLocationId,
  getLocations,
  hasGlobalPermission,
} from './permission-check';

export function usePermission(entity: string, action: string): boolean {
  const snapshot = useAuthStore((s) => s.snapshot);
  return useMemo(
    () => hasGlobalPermission(snapshot, entity, action),
    [snapshot, entity, action],
  );
}

export function useCanAccessStore(storeId: string): boolean {
  const snapshot = useAuthStore((s) => s.snapshot);
  return useMemo(() => canAccessStore(snapshot, storeId), [snapshot, storeId]);
}

export function useStoreLocations(storeId: string) {
  const snapshot = useAuthStore((s) => s.snapshot);
  return useMemo(() => getLocations(snapshot, storeId), [snapshot, storeId]);
}

export function useDefaultLocationId(storeId: string): string | null {
  const snapshot = useAuthStore((s) => s.snapshot);
  return useMemo(
    () => getDefaultLocationId(snapshot, storeId),
    [snapshot, storeId],
  );
}
