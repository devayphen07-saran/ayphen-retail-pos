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

export interface AuthUserResponse {
  id: string;
  permissions_version: number;
}

/** Returned by login/verify and signup/verify. */
export interface LoginResponse {
  access_token: string;
  refresh_token: string;
  user: AuthUserResponse;
  is_new_user: boolean;
  device_guuid: string;
  device_session_guuid: string;
  is_trusted: boolean;
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

export interface RefreshResponse {
  access_token: string;
  refresh_token: string;
  snapshot_version: number;
}

// ── Sessions ─────────────────────────────────────────────────────────────────

export interface SessionResponse {
  id: string;
  device_model?: string | null;
  device_platform?: string | null;
  is_current: boolean;
  created_at: string;
  last_used_at: string;
  ip_at_creation?: string | null;
}

// ── Device challenge / step-up ───────────────────────────────────────────────

export interface ChallengeResponse {
  challenge_id: string;
}

export type StepUpMethod = 'otp' | 'biometric' | 'totp' | 'password';

export interface StepUpVerifyRequest {
  method: StepUpMethod;
  credential?: string;
  otp_request_id?: string;
  challenge_id?: string;
  intended_window_seconds?: number;
}

export interface StepUpResponse {
  stepped_up: true;
  valid_until: string;
}
