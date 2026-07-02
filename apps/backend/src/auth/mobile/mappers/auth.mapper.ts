import type {
  LoginResult,
  StageOneResult,
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
      access_token:         r.accessToken,
      refresh_token:        r.refreshToken,
      user:                 { id: r.user.id, permissions_version: r.user.permissionsVersion },
      is_new_user:          r.isNewUser,
      device_guuid:         r.deviceGuuid,
      device_session_guuid: r.deviceSessionGuuid,
      is_trusted:           r.isTrusted,
    };
  },

  toRefreshResponse(r: RotateResult): RefreshResponse {
    return {
      access_token:     r.accessToken,
      refresh_token:    r.refreshToken,
      snapshot_version: r.snapshotVersion,
    };
  },
};
