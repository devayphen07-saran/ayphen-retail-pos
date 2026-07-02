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
  accessToken:        string;
  refreshToken:       string;
  user:               { id: string; permissionsVersion: number };
  isNewUser:          boolean;
  deviceGuuid:        string;
  deviceSessionGuuid: string;
  isTrusted:          boolean;
}
