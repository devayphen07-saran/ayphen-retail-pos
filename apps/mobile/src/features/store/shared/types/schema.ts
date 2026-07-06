import { z } from 'zod';

const GSTIN_REGEX = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const PAN_REGEX = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const PINCODE_REGEX = /^[1-9]\d{5}$/;
const URL_REGEX = /^https?:\/\/.+/;

const OpeningHourSchema = z.object({
  dayOfWeek: z.number().int().min(0).max(6),
  openTime: z.date().nullable(),
  closeTime: z.date().nullable(),
  isClosed: z.boolean(),
});

export const createStoreSchema = z.object({
  name: z.string().trim().min(1, 'Store name is required').max(120),

  // ── Identity ──────────────────────────────────────────────────────────────
  category: z.string().trim().max(60).optional().or(z.literal('')),
  description: z.string().trim().max(500).optional().or(z.literal('')),

  // ── Contact ───────────────────────────────────────────────────────────────
  phone: z.string().trim().max(20).optional().or(z.literal('')),
  email: z
    .string()
    .trim()
    .optional()
    .or(z.literal(''))
    .refine((v) => !v || z.email().safeParse(v).success, 'Enter a valid email'),
  website: z
    .string()
    .trim()
    .optional()
    .or(z.literal(''))
    .refine((v) => !v || URL_REGEX.test(v), 'Enter a valid URL starting with http:// or https://'),

  // ── Location ──────────────────────────────────────────────────────────────
  line1: z.string().trim().max(200).optional().or(z.literal('')),
  line2: z.string().trim().max(200).optional().or(z.literal('')),
  city: z.string().trim().max(100).optional().or(z.literal('')),
  state: z.string().trim().max(60).optional().or(z.literal('')),
  pincode: z
    .string()
    .trim()
    .optional()
    .or(z.literal(''))
    .refine((v) => !v || PINCODE_REGEX.test(v), 'Enter a valid 6-digit PIN code'),

  // ── Tax & legal ───────────────────────────────────────────────────────────
  currency: z.string().trim().max(10).optional().or(z.literal('')),
  gstin: z
    .string()
    .trim()
    .optional()
    .or(z.literal(''))
    .refine((v) => !v || GSTIN_REGEX.test(v.toUpperCase()), 'Enter a valid 15-character GSTIN'),
  gstRegistrationType: z.union([z.enum(['regular', 'composition']), z.literal('')]).optional(),
  pan: z
    .string()
    .trim()
    .optional()
    .or(z.literal(''))
    .refine((v) => !v || PAN_REGEX.test(v.toUpperCase()), 'Enter a valid 10-character PAN'),
  businessRegNumber: z.string().trim().max(60).optional().or(z.literal('')),
  migrationDate: z.date().optional().nullable(),
  makeDefault: z.boolean().optional(),

  // ── Opening hours ─────────────────────────────────────────────────────────
  openingHours: z.array(OpeningHourSchema),
});

export type CreateStoreForm = z.infer<typeof createStoreSchema>;

const DEFAULT_OPENING_HOURS: CreateStoreForm['openingHours'] = [
  { dayOfWeek: 0, openTime: null, closeTime: null, isClosed: true },
  { dayOfWeek: 1, openTime: null, closeTime: null, isClosed: false },
  { dayOfWeek: 2, openTime: null, closeTime: null, isClosed: false },
  { dayOfWeek: 3, openTime: null, closeTime: null, isClosed: false },
  { dayOfWeek: 4, openTime: null, closeTime: null, isClosed: false },
  { dayOfWeek: 5, openTime: null, closeTime: null, isClosed: false },
  { dayOfWeek: 6, openTime: null, closeTime: null, isClosed: false },
];

export const DEFAULT_CREATE_STORE_VALUES: CreateStoreForm = {
  name: '',
  category: '',
  description: '',
  phone: '',
  email: '',
  website: '',
  line1: '',
  line2: '',
  city: '',
  state: '',
  pincode: '',
  currency: 'INR',
  gstin: '',
  gstRegistrationType: '',
  pan: '',
  businessRegNumber: '',
  migrationDate: null,
  makeDefault: true,
  openingHours: DEFAULT_OPENING_HOURS,
};