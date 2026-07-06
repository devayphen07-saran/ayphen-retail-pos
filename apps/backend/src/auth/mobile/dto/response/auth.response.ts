import type { PermissionSnapshot } from '../../types/permission-snapshot.js';

/** Response after successful login/signup (stage 2). */
export interface LoginResponse {
  access_token:         string;
  refresh_token:        string;
  user:                 AuthUserResponse;
  is_new_user:          boolean;
  device_id:            string;
  device_session_id:    string;
  is_trusted:           boolean;
}

export interface AuthUserResponse {
  id:                  string;
  permissions_version: number;
}

/** Response after a token refresh / rotation. */
export interface RefreshResponse {
  access_token:     string;
  refresh_token:    string;
  snapshot_version: number;
  /** Present only when the client's snapshot is stale — mirrors `snapshot_changed`. */
  snapshot:             PermissionSnapshot | null;
  snapshot_signature:   string | null;
  snapshot_changed:     boolean;
  /** Always false today — reserved for changes the snapshot itself can't carry
   *  (e.g. a future schema_version bump). */
  force_bootstrap:      boolean;
  /** Simplification: mirrors `snapshot_changed` until the client sends its prior
   *  store-id set for a real diff (mobile-02 §3b). */
  store_access_changed: boolean;
}

/** Full session snapshot for an already-authenticated principal — what a
 *  cold-launch refresh (tokens only) is missing relative to a fresh login. */
export interface BootstrapResponse {
  user:                     AuthUserResponse;
  device_id:                string;
  device_session_id:        string;
  is_trusted:               boolean;
  permissions_version:      number;
  snapshot:                 PermissionSnapshot;
  snapshot_signature:       string;
  last_account_mode:        'business' | 'personal' | null;
  has_pending_invitations:  boolean;
  pending_invitation_count: number;
}
