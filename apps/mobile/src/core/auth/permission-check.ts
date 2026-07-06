/**
 * Pure read helpers over `PermissionSnapshot` for on-device UX gating.
 *
 * IMPORTANT — this is NOT a security boundary. `snapshot_signature` is
 * HMAC-signed with a server-only secret (`jwtAccessSecret`); the client has
 * no way to verify it and must not be given that secret. These helpers only
 * let the UI hide/disable actions a user can't perform, matching what the
 * server will do anyway — every mutation is still authorized for real by the
 * backend's RBAC guards on every request. Treat a "true" here as "don't
 * bother the user with a button that would 403", never as "safe to skip
 * server-side authorization".
 */

import type { PermissionSnapshot } from '@ayphen/api-manager';

type StoreLocationsEntry = PermissionSnapshot['storeLocations'][number];
type LocationEntry = StoreLocationsEntry['locations'][number];

export function hasGlobalPermission(
  snapshot: PermissionSnapshot | null | undefined,
  entity: string,
  action: string,
): boolean {
  return !!snapshot?.globalPermissions.includes(`${entity}:${action}`);
}

export function getStoreEntry(
  snapshot: PermissionSnapshot | null | undefined,
  storeId: string,
): StoreLocationsEntry | undefined {
  return snapshot?.storeLocations.find((s) => s.store_id === storeId);
}

export function canAccessStore(
  snapshot: PermissionSnapshot | null | undefined,
  storeId: string,
): boolean {
  return !!getStoreEntry(snapshot, storeId);
}

export function getLocations(
  snapshot: PermissionSnapshot | null | undefined,
  storeId: string,
): LocationEntry[] {
  return getStoreEntry(snapshot, storeId)?.locations ?? [];
}

export function getDefaultLocationId(
  snapshot: PermissionSnapshot | null | undefined,
  storeId: string,
): string | null {
  return getStoreEntry(snapshot, storeId)?.default_location_id ?? null;
}
