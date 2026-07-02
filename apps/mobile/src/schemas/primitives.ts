import { z } from 'zod';

/**
 * Reusable validation primitives (form-pattern.md §13). Define once, import
 * everywhere; when a rule changes, every form picks it up.
 */

/**
 * Phone in the format the backend accepts (E.164-ish): optional leading +,
 * first digit 1-9, 7-15 total digits. Mirrors the backend PHONE_REGEX in
 * apps/backend/src/auth/mobile/dto/request/device.request.ts.
 */
export const phone = z
  .string()
  .regex(/^\+?[1-9]\d{6,14}$/, 'Enter a valid phone number');

/** A 6-digit numeric OTP code. */
export const otpCode = z
  .string()
  .length(6, 'Enter the 6-digit code')
  .regex(/^\d{6}$/, 'Code must be 6 digits');

/** A person's display name. */
export const personName = z
  .string()
  .min(1, 'Name is required')
  .max(100, 'Name must be 100 characters or fewer');
