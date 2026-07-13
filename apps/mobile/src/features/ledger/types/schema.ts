import { z } from 'zod';

/**
 * The two manual movement types the Add Transaction sheet exposes (F4,
 * docs/prd/accounts-and-ledger.md). `drop`/`tip` and `float` exist on the
 * backend's `cash_movements.type`/reason vocabulary but are deferred to the
 * shift-ceremony phase (F7) — they only make sense once a `shift_session` to
 * attach them to actually exists.
 */
export const CASH_MOVEMENT_TYPES = ['payin', 'payout'] as const;
export type CashMovementType = (typeof CASH_MOVEMENT_TYPES)[number];

export const createCashMovementSchema = z
  .object({
    type: z.enum(CASH_MOVEMENT_TYPES),
    amountPaise: z.number().int().positive().nullable(),
    reason: z.string().trim().max(280).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.amountPaise == null) {
      ctx.addIssue({
        code: 'custom',
        path: ['amountPaise'],
        message: 'Enter an amount greater than ₹0.',
      });
    }
    // BR-7 / V-7 — mirrors cash-movement.handler.ts's server-side check.
    if (data.type === 'payout' && !data.reason?.trim()) {
      ctx.addIssue({
        code: 'custom',
        path: ['reason'],
        message: 'Add a reason for this cash-out.',
      });
    }
  });

export type CreateCashMovementForm = z.infer<typeof createCashMovementSchema>;

export const DEFAULT_CREATE_CASH_MOVEMENT_VALUES: CreateCashMovementForm = {
  type: 'payin',
  amountPaise: null,
  reason: '',
};