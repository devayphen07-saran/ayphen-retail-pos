import type { PermissionSnapshot } from '#common/types/permission-snapshot.js';

/** Response after successful login/signup (stage 2). Carries the same
 *  routing fields (snapshot, account mode, invitation count) as
 *  `BootstrapResponse` so the client never has to make a second round trip
 *  after login/signup just to route the user. `snapshot`/`snapshot_signature`
 *  are nullable: a snapshot-build failure doesn't fail the login — the client
 *  falls back to its existing bootstrap call when they're absent. */
export interface LoginResponse {
  access_token:             string;
  refresh_token:            string;
  device_session_id:        string;
  snapshot:                 PermissionSnapshot | null;
  snapshot_signature:       string | null;
  last_account_mode:        'business' | 'personal' | null;
  pending_invitation_count: number;
  /** `false` ⇒ the user has no email on file — the client gates straight into
   *  `/(onboarding)/complete-profile` on this, the same way it gates on
   *  `last_account_mode`. Never null/fallible, unlike the snapshot fields. */
  profile_complete:         boolean;
}

/** Response after a token refresh / rotation. */
export interface RefreshResponse {
  access_token:     string;
  refresh_token:    string;
  snapshot_version: number;
  /** Present only when the client's snapshot is stale. */
  snapshot:             PermissionSnapshot | null;
  snapshot_signature:   string | null;
}

/** Full session snapshot for an already-authenticated principal — what a
 *  cold-launch refresh (tokens only) is missing relative to a fresh login. */
export interface BootstrapResponse {
  device_session_id:        string;
  snapshot:                 PermissionSnapshot;
  snapshot_signature:       string;
  last_account_mode:        'business' | 'personal' | null;
  pending_invitation_count: number;
  profile_complete:         boolean;
}

/** GET /me/profile response — display data for the profile screen. Fetched
 *  independently of login/bootstrap (see ProfileResult's doc comment). */
export interface ProfileResponse {
  name:                string;
  email:               string | null;
  phone:               string | null;
  phone_verified:      boolean;
  profile_picture_url: string | null;
}
