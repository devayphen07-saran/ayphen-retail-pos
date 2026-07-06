/**
 * The signed permission snapshot shape (rbac.md §14, adoption §8.2). Lives here
 * — not in `snapshot.service.ts` — so it's a true leaf type: both the service
 * that builds it and the response DTOs that carry it import from here, and
 * neither imports the other (layered-architecture.md §3.8 — a response DTO
 * never imports anything from the module).
 *
 * The snake_case field names below are intentional, not an oversight: this
 * shape is signed byte-for-byte (`CryptoService.canonicalJson` + `signSnapshot`)
 * and sent to the client as-is — a response mapper reshaping it would
 * invalidate the signature. It is the one wire-facing shape that lives outside
 * `dto/response/` because its bytes, not just its type, are the contract.
 */

/** A location the user may open within a store (adoption §8.2, rbac.md §26.8). */
export interface LocationSnapshotEntry {
  id:         string;
  name:       string;
  is_primary: boolean;  // Head Office
  is_default: boolean;
  is_locked:  boolean;
}

/** Per-store location access, so an offline device can pick a startup location. */
export interface StoreLocationsEntry {
  store_id:            string;
  name:                string;
  default_location_id: string | null;
  locations:           LocationSnapshotEntry[];
}

export interface PermissionSnapshot {
  userId:             string;
  permissionsVersion: number;
  generatedAt:        string;
  globalPermissions:  string[];
  storeLocations:     StoreLocationsEntry[];
}

export interface SnapshotResult {
  snapshot:  PermissionSnapshot;
  signature: string;
}
