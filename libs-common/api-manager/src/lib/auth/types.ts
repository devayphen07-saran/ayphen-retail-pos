/**
 * Wire types for the auth domain. Field names mirror the backend DTOs
 * (snake_case) exactly — see `apps/backend/src/auth/mobile/dto`.
 */

// ── Device payload (sent on login/signup verify) ─────────────────────────────

export type DevicePlatform = 'ios' | 'android';

/** Sent as `device` on stage-2 verify. `public_key` is the base64 Ed25519 key. */
export interface DeviceRequest {
  platform: DevicePlatform;
  app_version: string;
  os_version?: string;
  model?: string;
  public_key: string;
  push_token?: string;
  attestation?: string;
}

// ── Stage 1 — OTP request ────────────────────────────────────────────────────

export interface OtpRequest {
  phone: string;
  /** Previous `otp_request_id` when this is a resend. */
  resend_of?: string;
}

export interface OtpChallengeResponse {
  otp_sent: true;
  otp_request_id: string;
  expires_in: number;
}

// ── Stage 2 — verify ─────────────────────────────────────────────────────────

export interface OtpVerifyRequest {
  phone: string;
  otp_code: string;
  otp_request_id: string;
  device: DeviceRequest;
}

export interface SignupVerifyRequest extends OtpVerifyRequest {
  name: string;
  /** Must be literally `true` — the backend rejects anything else. */
  consent_given: true;
}

/** Returned by login/verify and signup/verify. Carries the same routing
 *  fields (snapshot, account mode, invitation count) as `BootstrapResponse`
 *  so the client never has to make a second round trip after login/signup
 *  just to route the user. `snapshot`/`snapshot_signature` are nullable: a
 *  snapshot-build failure doesn't fail the login — fall back to a bootstrap
 *  call when they're absent. */
export interface LoginResponse {
  access_token: string;
  refresh_token: string;
  device_session_id: string;
  snapshot: PermissionSnapshot | null;
  snapshot_signature: string | null;
  last_account_mode: AccountMode | null;
  pending_invitation_count: number;
  /** `false` ⇒ no email on file — AppGate redirects to
   *  `/(onboarding)/complete-profile` on this, same chokepoint as
   *  `last_account_mode`. */
  profile_complete: boolean;
}

// ── Refresh ──────────────────────────────────────────────────────────────────

export interface RefreshRequest {
  refresh_token: string;
  /** Optional device-binding proof (from MOBILE_CHALLENGE + Ed25519 signature). */
  challenge_id?: string;
  device_signature?: string;
  /** Last cached permissions/snapshot version, so the server can signal staleness. */
  snapshot_version?: number;
}

/**
 * Signed permission snapshot — opaque on the client today (no on-device
 * verification or offline gating consumes it yet). Kept camelCase, matching
 * the backend's internal `PermissionSnapshot` shape exactly, since it's
 * treated as an opaque signed document rather than individually-read fields.
 */
export interface PermissionSnapshot {
  userId: string;
  permissionsVersion: number;
  generatedAt: string;
  stores: {
    store_id: string;
    name: string;
    /** This user's own `entityCode:action` CRUD grants IN THIS STORE — never
     *  cross-store-flattened (that was the bug: a permission held in one
     *  store leaking into gating for another). */
    permissions: string[];
  }[];
}

export interface RefreshResponse {
  access_token: string;
  refresh_token: string;
  snapshot_version: number;
  /** Present only when the client's snapshot is stale. */
  snapshot: PermissionSnapshot | null;
  snapshot_signature: string | null;
}

/** Body for REFRESH_CHALLENGE — the refresh token identifies the device. */
export interface RefreshChallengeRequest {
  refresh_token: string;
}

/**
 * Full session snapshot for an already-authenticated principal — what a
 * cold-launch refresh (tokens only) is missing relative to a fresh login.
 */
export type AccountMode = 'business' | 'personal';

export interface BootstrapResponse {
  device_session_id: string;
  snapshot: PermissionSnapshot;
  snapshot_signature: string;
  last_account_mode: AccountMode | null;
  pending_invitation_count: number;
  profile_complete: boolean;
}

export interface AccountModeRequest {
  mode: AccountMode;
}

/** Display data for GET /me/profile. */
export interface ProfileResponse {
  name: string;
  email: string | null;
  phone: string | null;
  phone_verified: boolean;
  profile_picture_url: string | null;
}

/** Body for PATCH /me/profile — both fields optional, only supplied keys are
 *  written. No `phone`: it's the login credential and needs its own
 *  OTP-reverification flow, not a plain PATCH. */
export interface UpdateProfileRequest {
  name?: string;
  email?: string;
}

// ── Sessions ─────────────────────────────────────────────────────────────────

// Cursor-paginated envelope — matches the backend `PaginatedResponse<T>`
// (common/pagination/paginated-response.ts). `GET /auth/mobile/sessions`
// returns this shape inside the response envelope's `data`, not a bare array.
export interface Paginated<T> {
  data: T[];
  next_cursor: string | null;
  has_more: boolean;
}

// Field names mirror the backend SessionMapper.toSessionResponse output exactly.
export interface SessionResponse {
  id: string;
  device_name: string | null;
  os: string | null;
  platform: string | null;
  app_version: string | null;
  ip_at_creation: string | null;
  last_used_at: string;
  last_step_up_at: string | null;
  created_at: string;
  is_current: boolean;
}

// ── Device challenge / step-up ───────────────────────────────────────────────

export interface ChallengeResponse {
  challenge_id: string;
}

// Matches the backend StepUpVerifyDto method enum exactly.
export type StepUpMethod = 'otp_sms' | 'biometric' | 'totp' | 'password_reentry';

export interface StepUpVerifyRequest {
  method: StepUpMethod;
  credential: string;
  otp_request_id?: string;
  challenge_id?: string;
  intended_window_seconds?: number;
}

export interface StepUpResponse {
  ok: true;
  method: StepUpMethod;
  completed_at: string;
  valid_until: string;
}
