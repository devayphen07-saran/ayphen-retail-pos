import { z } from 'zod';

/** Money on the wire: number or numeric string → canonical 2-dp string for pg numeric. */
export const money = z
  .union([
    z.number().nonnegative().finite(),
    z.string().regex(/^\d{1,10}(\.\d{1,2})?$/, 'must be a non-negative amount'),
  ])
  .transform((v) => (typeof v === 'number' ? v.toFixed(2) : v));

/** Quantity: up to 3 dp (fractional units — kg, litres). */
export const quantity = z
  .union([
    z.number().positive().finite(),
    z.string().regex(/^\d{1,9}(\.\d{1,3})?$/, 'must be a positive quantity'),
  ])
  .transform((v) => (typeof v === 'number' ? String(v) : v));

/** Indian tax identifiers. GSTIN = 2-digit state + 10-char PAN + entity + check
 *  + Z + check; PAN = 5 letters + 4 digits + letter. Format is enforced here
 *  (not a DB CHECK) because offline mutations only reach validation at sync. */
const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

/** GSTIN 15-char format, or empty string. Pair with `.nullish()` at the field. */
export const gstin = z.union([
  z.string().regex(GSTIN_RE, 'Enter a valid 15-character GSTIN'),
  z.literal(''),
]);

/** PAN 10-char format, or empty string. Pair with `.nullish()` at the field. */
export const pan = z.union([
  z.string().regex(PAN_RE, 'Enter a valid 10-character PAN'),
  z.literal(''),
]);

/** 6-digit Indian PIN code, or empty string. Pair with `.nullish()`. */
export const pinCode = z.union([
  z.string().regex(/^\d{6}$/, 'PIN code must be 6 digits'),
  z.literal(''),
]);

/** Net (custom) payment-term days, 1–999. Pair with `.nullish()`. */
export const paymentTermDays = z
  .number()
  .int()
  .min(1, 'Enter a value between 1 and 999')
  .max(999, 'Enter a value between 1 and 999');

/** Drop undefined values so partial updates only touch the fields sent. */
export function prune(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, v]) => v !== undefined));
}

/**
 * Build an update schema from a create-schema's field map: every field
 * becomes optional (a partial update only touches the fields the client
 * sent), `guuid` stays required to identify which row to update. `base` is
 * typed as `Record<string, z.ZodType>` so `s.optional()` is called on a
 * known ZodType directly — no `as z.ZodType` cast needed at call sites.
 */
export function partialUpdateSchema(
  base: Record<string, z.ZodType>,
): z.ZodType<Record<string, unknown>> {
  return z.object({
    guuid: z.uuid(),
    ...Object.fromEntries(
      Object.entries(base).map(([k, s]) => [k, s.optional()]),
    ),
  });
}
