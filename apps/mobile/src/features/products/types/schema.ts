import { z } from 'zod';

/** Mirrors the backend's `money` schema (payload-helpers.ts) — up to 2dp,
 *  non-negative. Kept as a string end to end (never a float) to avoid the
 *  precision loss the server explicitly designed around. */
const moneyString = z
  .string()
  .trim()
  .regex(/^\d{1,10}(\.\d{1,2})?$/, 'Enter a valid amount (e.g. 199 or 199.50)');

export const createProductSchema = z.object({
  name: z.string().trim().min(1, 'Required').max(200),
  sku: z.string().trim().max(64).optional(),
  barcode: z.string().trim().max(64).optional(),
  sellingPrice: moneyString,
  costPrice: z.union([moneyString, z.literal('')]).optional(),
  mrp: z.union([moneyString, z.literal('')]).optional(),
  trackInventory: z.boolean().optional(),
});

export type CreateProductForm = z.infer<typeof createProductSchema>;

export const DEFAULT_CREATE_PRODUCT_VALUES: CreateProductForm = {
  name: '',
  sku: '',
  barcode: '',
  sellingPrice: '',
  costPrice: '',
  mrp: '',
  trackInventory: true,
};
