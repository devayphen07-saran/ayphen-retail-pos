/** Response when an OTP challenge is issued (login/signup stage 1). */
export interface OtpChallengeResponse {
  otp_sent:        true;
  otp_request_id:  string;
  expires_in:      number;
}
