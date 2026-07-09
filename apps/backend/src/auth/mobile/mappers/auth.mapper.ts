import type {
  LoginResult,
  StageOneResult,
  BootstrapResult,
  ProfileResult,
} from '../types/auth-result.js';
import type { RotateResult } from '../services/refresh-token.service.js';
import type { OtpChallengeResponse } from '../dto/response/otp.response.js';
import type {
  LoginResponse,
  RefreshResponse,
  BootstrapResponse,
  ProfileResponse,
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

  toLoginResponse(r: LoginResult): LoginResponse {
    return {
      access_token:             r.accessToken,
      refresh_token:            r.refreshToken,
      device_session_id:        r.deviceSessionId,
      snapshot:                 r.snapshot,
      snapshot_signature:       r.snapshotSignature,
      last_account_mode:        r.lastAccountMode,
      pending_invitation_count: r.pendingInvitationCount,
      profile_complete:         r.profileComplete,
    };
  },

  toRefreshResponse(r: RotateResult): RefreshResponse {
    return {
      access_token:     r.accessToken,
      refresh_token:    r.refreshToken,
      snapshot_version: r.snapshotVersion,
      snapshot:           r.snapshotResult?.snapshot ?? null,
      snapshot_signature: r.snapshotResult?.signature ?? null,
    };
  },

  toBootstrapResponse(r: BootstrapResult): BootstrapResponse {
    return {
      device_session_id:        r.deviceSessionId,
      snapshot:                 r.snapshot,
      snapshot_signature:       r.snapshotSignature,
      last_account_mode:        r.lastAccountMode,
      pending_invitation_count: r.pendingInvitationCount,
      profile_complete:         r.profileComplete,
    };
  },

  toProfileResponse(r: ProfileResult): ProfileResponse {
    return {
      name:                r.name,
      email:               r.email,
      phone:               r.phone,
      phone_verified:      r.phoneVerified,
      profile_picture_url: r.profilePictureUrl,
    };
  },
};
