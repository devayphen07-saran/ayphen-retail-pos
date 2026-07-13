import { z } from 'zod';

/** Mirrors the backend's `money` schema (payload-helpers.ts) — up to 2dp,
 *  non-negative. Kept as a string end to end (never a float). */
const moneyString = z
  .string()
  .trim()
  .regex(/^\d{1,10}(\.\d{1,2})?$/, 'Enter a valid amount (e.g. 199 or 199.50)');

/** Indian tax identifiers — same regexes as backend payload-helpers.ts. */
const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

const optionalOrEmpty = <T extends z.ZodTypeAny>(schema: T) =>
  z.union([schema, z.literal('')]).optional();

export const createCustomerSchema = z.object({
  // Bounds mirror the customers PRD (§4/§24) — stricter than the backend base
  // (1–200) because this is the authoring client.
  name: z.string().trim().min(3, 'Name must be at least 3 characters').max(100),
  phone: optionalOrEmpty(
    z.string().trim().regex(/^[6-9]\d{9}$/, 'Enter a valid Indian phone number'),
  ),
  email: optionalOrEmpty(z.string().trim().email('Enter a valid email').max(255)),
  website: optionalOrEmpty(z.string().trim().max(255)),
  gstNumber: optionalOrEmpty(
    z.string().trim().regex(GSTIN_RE, 'Enter a valid 15-character GSTIN'),
  ),
  panNumber: optionalOrEmpty(
    z.string().trim().regex(PAN_RE, 'Enter a valid 10-character PAN'),
  ),
  creditLimit: optionalOrEmpty(moneyString),
  overrideCreditLimit: z.boolean().optional(),
  paymentTermDays: optionalOrEmpty(
    z.string().trim().regex(/^\d{1,3}$/, 'Enter a value between 1 and 999'),
  ),
  addressLine1: optionalOrEmpty(z.string().trim().max(100)),
  addressLine2: optionalOrEmpty(z.string().trim().max(100)),
  city: optionalOrEmpty(z.string().trim().max(50)),
  district: optionalOrEmpty(z.string().trim().max(50)),
  // The selected STATE lookup's guuid (→ state_lookup_guuid on the wire), not
  // free text. Optional; empty when unset.
  state: optionalOrEmpty(z.string().trim()),
  pinCode: optionalOrEmpty(
    z.string().trim().regex(/^\d{6}$/, 'PIN code must be 6 digits'),
  ),
  birthday: optionalOrEmpty(z.string().trim()), // ISO YYYY-MM-DD
  anniversary: optionalOrEmpty(z.string().trim()),
  notes: optionalOrEmpty(z.string().trim().max(250)),
});

export type CreateCustomerForm = z.infer<typeof createCustomerSchema>;

export const DEFAULT_CREATE_CUSTOMER_VALUES: CreateCustomerForm = {
  name: '',
  phone: '',
  email: '',
  website: '',
  gstNumber: '',
  panNumber: '',
  creditLimit: '',
  overrideCreditLimit: false,
  paymentTermDays: '',
  addressLine1: '',
  addressLine2: '',
  city: '',
  district: '',
  state: '',
  pinCode: '',
  birthday: '',
  anniversary: '',
  notes: '',
};