import { z } from 'zod';
import { phone, otpCode, personName } from '../../schemas/primitives';

/**
 * Step 1 — phone entry. A single unified schema for both login and signup so
 * the form's type is stable (`PhoneForm`) regardless of mode. In login mode
 * `name` is ignored; in signup mode it's required via superRefine, driven by
 * the `isSignup` flag baked into the resolver at the call site.
 */
function makePhoneSchema(isSignup: boolean) {
  return z
    .object({
      phone,
      name: z.string(),
      /** Optional marketing consent — signup only, never blocks submit. */
      marketingOptIn: z.boolean(),
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
    });
}

export const loginPhoneSchema = makePhoneSchema(false);
export const signupPhoneSchema = makePhoneSchema(true);

export type PhoneForm = z.infer<typeof loginPhoneSchema>;
export const DEFAULT_PHONE_VALUES: PhoneForm = {
  phone: '',
  name: '',
  marketingOptIn: false,
};

/**
 * Step 2 — OTP verification. The only field the user enters here is the code.
 * Terms/Privacy consent is given implicitly on the phone screen ("By continuing
 * you agree to our Terms and Privacy Policy") when the user taps Register, so
 * `consent_given: true` is sent to the backend at verify time without a second
 * checkbox. Login and signup share this schema so `OtpVerifyForm` is stable.
 */
const otpVerifySchema = z.object({
  otp: otpCode,
});

export const loginOtpSchema = otpVerifySchema;
export const signupOtpSchema = otpVerifySchema;

export type OtpVerifyForm = z.infer<typeof otpVerifySchema>;
export const DEFAULT_OTP_VERIFY_VALUES: OtpVerifyForm = {
  otp: '',
};
