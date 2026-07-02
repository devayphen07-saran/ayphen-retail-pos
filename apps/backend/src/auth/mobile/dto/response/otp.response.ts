/** Response when an OTP challenge is issued (login/signup stage 1). */
export interface OtpChallengeResponse {
  otp_sent:        true;
  otp_request_id:  string;
  expires_in:      number;
}

/** Richer OTP-request response (masked phone + resend window). */
export interface OtpRequestResponse {
  otp_request_id:       string;
  phone_masked:         string;
  expires_in:           number;
  resend_available_in:  number;
  max_attempts:         number;
}
