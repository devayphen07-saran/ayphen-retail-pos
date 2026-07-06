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

/** Drop undefined values so partial updates only touch the fields sent. */
export function prune(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, v]) => v !== undefined));
}
