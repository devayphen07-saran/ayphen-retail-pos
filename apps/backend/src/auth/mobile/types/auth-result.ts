import type { PermissionSnapshot } from '../services/snapshot.service.js';

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

/** Result of a completed login or signup (stage 2). */
export interface LoginResult {
  accessToken:     string;
  refreshToken:    string;
  user:            { id: string; permissionsVersion: number };
  isNewUser:       boolean;
  deviceId:        string;
  deviceSessionId: string;
  isTrusted:       boolean;
}

/** Full session snapshot for an already-authenticated principal — the same
 *  shape LoginResult gives fresh-login, minus the tokens (client already has
 *  those; this is what refresh's token-only response can't provide). */
export interface BootstrapResult {
  user:                  { id: string; permissionsVersion: number };
  deviceId:              string;
  deviceSessionId:       string;
  isTrusted:             boolean;
  snapshot:              PermissionSnapshot;
  snapshotSignature:     string;
  lastAccountMode:       'business' | 'personal' | null;
  hasPendingInvitations: boolean;
  pendingInvitationCount: number;
}
