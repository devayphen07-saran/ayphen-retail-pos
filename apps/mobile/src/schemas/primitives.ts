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
  .trim()
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

/** GSTIN — 15-char Indian GST identification number. Case-insensitive input,
 *  optional (empty string is valid — not every store has one on file yet). */
export const optionalGstin = z
  .string()
  .trim()
  .optional()
  .or(z.literal(''))
  .refine((v) => !v || /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(v.toUpperCase()), 'Enter a valid 15-character GSTIN');

/** PAN — 10-char Indian permanent account number. Case-insensitive, optional. */
export const optionalPan = z
  .string()
  .trim()
  .optional()
  .or(z.literal(''))
  .refine((v) => !v || /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(v.toUpperCase()), 'Enter a valid 10-character PAN');

/** Indian 6-digit PIN code, optional. */
export const optionalPincode = z
  .string()
  .trim()
  .optional()
  .or(z.literal(''))
  .refine((v) => !v || /^[1-9]\d{5}$/.test(v), 'Enter a valid 6-digit PIN code');
