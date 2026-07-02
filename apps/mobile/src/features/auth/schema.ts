import { z } from 'zod';
import { phone, otpCode, personName } from '../../schemas/primitives';

/** Step 1 — phone entry (form-pattern.md §4: flat schema, user-facing messages). */
export const phoneSchema = z.object({
  phone,
});
export type PhoneForm = z.infer<typeof phoneSchema>;
export const DEFAULT_PHONE_VALUES: PhoneForm = { phone: '' };

/**
 * Step 2 — a single unified schema for both login and signup so the form's
 * type is stable (`OtpVerifyForm`) regardless of mode. In login mode `name`
 * and `consent` are ignored; in signup mode they are required via superRefine,
 * driven by the `isSignup` flag baked into the resolver at the call site.
 */
function makeOtpVerifySchema(isSignup: boolean) {
  return z
    .object({
      otp: otpCode,
      name: z.string(),
      consent: z.boolean(),
    })
    .superRefine((val, ctx) => {
      if (!isSignup) return;
      const nameResult = personName.safeParse(val.name);
      if (!nameResult.success) {
        ctx.addIssue({
          code: 'custom',
          path: ['name'],
          message: nameResult.error.issues[0]?.message ?? 'Name is required',
        });
      }
      if (val.consent !== true) {
        ctx.addIssue({
          code: 'custom',
          path: ['consent'],
          message: 'Please accept to continue',
        });
      }
    });
}

export const loginOtpSchema = makeOtpVerifySchema(false);
export const signupOtpSchema = makeOtpVerifySchema(true);

export type OtpVerifyForm = z.infer<typeof loginOtpSchema>;
export const DEFAULT_OTP_VERIFY_VALUES: OtpVerifyForm = {
  otp: '',
  name: '',
  consent: false,
};
