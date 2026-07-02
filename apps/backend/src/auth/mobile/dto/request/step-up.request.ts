import { z } from 'zod';
import { PHONE_REGEX } from './device.request.js';

/** Request an OTP for otp_sms step-up. */
export const StepUpRequestDtoSchema = z.object({
  phone: z.string().regex(PHONE_REGEX),
});
export type StepUpRequestDto = z.infer<typeof StepUpRequestDtoSchema>;

/** Verify a step-up challenge (otp_sms / biometric / totp / password_reentry). */
export const StepUpVerifyDtoSchema = z
  .object({
    method:                  z.enum(['otp_sms', 'biometric', 'totp', 'password_reentry']),
    credential:              z.string().min(1),
    otp_request_id:          z.string().uuid().optional(),
    challenge_id:            z.string().uuid().optional(),
    intended_window_seconds: z.number().int().min(1).max(3600).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.method === 'otp_sms' && !v.otp_request_id) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'otp_request_id required for otp_sms', path: ['otp_request_id'] });
    }
    if (v.method === 'biometric' && !v.challenge_id) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'challenge_id required for biometric', path: ['challenge_id'] });
    }
  });
export type StepUpVerifyDto = z.infer<typeof StepUpVerifyDtoSchema>;
