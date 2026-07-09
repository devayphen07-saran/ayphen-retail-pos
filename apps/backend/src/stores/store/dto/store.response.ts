/** POST /stores response (layered-architecture §3.8). snake_case wire contract. */
import type { PermissionSnapshot } from '#common/types/permission-snapshot.js';

/** `snapshot`/`snapshot_signature` are a refreshed permission snapshot the
 *  client can patch into its session in place instead of a full
 *  `GET /me/bootstrap` round trip. Nullable — a snapshot-build failure
 *  doesn't fail store creation; the client falls back to its existing
 *  bootstrap call when these are absent. */
export interface StoreResponse {
  id:                 string;
  name:               string;
  snapshot:           PermissionSnapshot | null;
  snapshot_signature: string | null;
}