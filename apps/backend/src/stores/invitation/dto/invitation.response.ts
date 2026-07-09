/** Wire contracts for invitation endpoints (snake_case). */
import type { PermissionSnapshot } from '#common/types/permission-snapshot.js';

export interface MyInvitationResponse {
  id:         string;
  store_id:   string;
  store_name: string;
  role_name:  string;
  expires_at: string;
}

/** Wire shape for accept/acceptById — the store the caller just joined, plus a
 *  refreshed permission snapshot so the client can patch its session state in
 *  place instead of making a full `GET /me/bootstrap` round trip. Nullable —
 *  a snapshot-build failure doesn't fail the accept; the client falls back to
 *  its existing bootstrap call when these are absent. */
export interface AcceptInvitationResponse {
  store_id:           string;
  snapshot:           PermissionSnapshot | null;
  snapshot_signature: string | null;
}

/** Wire shape for POST /stores/:storeId/invitations — the raw token, for delivery. */
export interface CreatedInvitationResponse {
  id:    string;
  token: string;
}

/** Wire shape for reject/rejectById acknowledgements. */
export interface InvitationActionResponse {
  ok: true;
}