import { z } from 'zod';
import { DeviceDtoSchema, PHONE_REGEX } from './device.request.js';

/** Stage 1 — request an OTP (login or signup). */
export const OtpRequestDtoSchema = z.object({
  phone:     z.string().regex(PHONE_REGEX, 'Invalid phone number'),
  resend_of: z.string().uuid().optional(),
});
export type OtpRequestDto = z.infer<typeof OtpRequestDtoSchema>;

/** Stage 2 — verify OTP and issue tokens (login). */
export const OtpVerifyDtoSchema = z.object({
  phone:          z.string().regex(PHONE_REGEX),
  otp_code:       z.string().length(6),
  otp_request_id: z.string().uuid(),
  device:         DeviceDtoSchema,
});
export type OtpVerifyDto = z.infer<typeof OtpVerifyDtoSchema>;

/** Stage 2 — verify OTP and create account (signup). */
export const SignupVerifyDtoSchema = OtpVerifyDtoSchema.extend({
  name:          z.string().min(1).max(100),
  consent_given: z.literal(true),
});
export type SignupVerifyDto = z.infer<typeof SignupVerifyDtoSchema>;
