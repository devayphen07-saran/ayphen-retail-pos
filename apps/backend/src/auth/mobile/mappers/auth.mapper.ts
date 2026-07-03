import type {
  LoginResult,
  StageOneResult,
  BootstrapResult,
} from '../types/auth-result.js';
import type { RotateResult } from '../services/refresh-token.service.js';
import type { OtpRequestResult } from '../services/otp-request.service.js';
import type {
  OtpChallengeResponse,
  OtpRequestResponse,
} from '../dto/response/otp.response.js';
import type {
  LoginResponse,
  RefreshResponse,
  BootstrapResponse,
} from '../dto/response/auth.response.js';

/**
 * Maps internal service results (domain shapes) to the snake_case
 * Response DTOs returned to mobile clients. Pure functions — no DI,
 * no side effects.
 */
export const AuthMapper = {
  toOtpChallengeResponse(r: StageOneResult): OtpChallengeResponse {
    return {
      otp_sent:       r.otpSent,
      otp_request_id: r.otpRequestId,
      expires_in:     r.expiresIn,
    };
  },

  toOtpRequestResponse(r: OtpRequestResult): OtpRequestResponse {
    return {
      otp_request_id:      r.otpRequestId,
      phone_masked:        r.phoneMasked,
      expires_in:          r.expiresIn,
      resend_available_in: r.resendAvailableIn,
      max_attempts:        r.maxAttempts,
    };
  },

  toLoginResponse(r: LoginResult): LoginResponse {
    return {
      access_token:      r.accessToken,
      refresh_token:     r.refreshToken,
      user:              { id: r.user.id, permissions_version: r.user.permissionsVersion },
      is_new_user:       r.isNewUser,
      device_id:         r.deviceId,
      device_session_id: r.deviceSessionId,
      is_trusted:        r.isTrusted,
    };
  },

  toRefreshResponse(r: RotateResult): RefreshResponse {
    return {
      access_token:     r.accessToken,
      refresh_token:    r.refreshToken,
      snapshot_version: r.snapshotVersion,
      snapshot:             r.snapshotResult?.snapshot ?? null,
      snapshot_signature:   r.snapshotResult?.signature ?? null,
      snapshot_changed:     r.snapshotResult !== null,
      force_bootstrap:      false,
      store_access_changed: r.snapshotResult !== null,
    };
  },

  toBootstrapResponse(r: BootstrapResult): BootstrapResponse {
    return {
      user:                    { id: r.user.id, permissions_version: r.user.permissionsVersion },
      device_id:               r.deviceId,
      device_session_id:       r.deviceSessionId,
      is_trusted:              r.isTrusted,
      permissions_version:     r.user.permissionsVersion,
      snapshot:                r.snapshot,
      snapshot_signature:      r.snapshotSignature,
      last_account_mode:       r.lastAccountMode,
      has_pending_invitations: r.hasPendingInvitations,
      pending_invitation_count: r.pendingInvitationCount,
    };
  },
};
