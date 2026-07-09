import type { PermissionSnapshot } from '#common/types/permission-snapshot.js';

/**
 * Domain result types produced by the auth services (login / signup) and
 * consumed by the response mappers. camelCase, internal — never cross the wire
 * as-is.
 */

/** Result of stage 1 (OTP request) for login or signup. */
export interface StageOneResult {
  otpSent:      true;
  expiresIn:    number;
  otpRequestId: string;
}

/** Result of a completed login or signup (stage 2). Carries the same routing
 *  data (snapshot, account mode, invitation count) `BootstrapResult` gives a
 *  cold-launch refresh, so a fresh login/signup never has to make a second
 *  round trip just to route the user. `snapshot`/`snapshotSignature` are
 *  nullable so a snapshot-build failure can't fail an otherwise-successful
 *  login — the client falls back to its existing bootstrap call. */
export interface LoginResult {
  accessToken:            string;
  refreshToken:           string;
  deviceSessionId:        string;
  snapshot:               PermissionSnapshot | null;
  snapshotSignature:      string | null;
  lastAccountMode:        'business' | 'personal' | null;
  pendingInvitationCount: number;
  /** `true` once the user has an email on file. Unlike snapshot/lastAccountMode
   *  this is never fallible (derived straight off the already-loaded user row),
   *  so it's always accurate even when the best-effort snapshot embed fails. */
  profileComplete:        boolean;
}

/** Full session snapshot for an already-authenticated principal — the same
 *  shape LoginResult gives fresh-login, minus the tokens (client already has
 *  those; this is what refresh's token-only response can't provide). */
export interface BootstrapResult {
  deviceSessionId:        string;
  snapshot:               PermissionSnapshot;
  snapshotSignature:      string;
  lastAccountMode:        'business' | 'personal' | null;
  pendingInvitationCount: number;
  profileComplete:        boolean;
}

/** Display data for GET /me/profile. Deliberately NOT part of LoginResult/
 *  BootstrapResult — unlike those (routing facts needed the instant the app
 *  launches), this is display data for one screen the user may rarely visit,
 *  fetched fresh only when that screen mounts. */
export interface ProfileResult {
  name:              string;
  email:             string | null;
  phone:             string | null;
  phoneVerified:     boolean;
  profilePictureUrl: string | null;
}
