import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { and, eq, isNull, ne } from 'drizzle-orm';
import { ErrorCodes } from '#common/error-codes.js';
import { paymentAccounts } from '#db/schema.js';
import { TombstoneRepository } from '../../repositories/tombstone.repository.js';
import { MasterDataSyncHandler } from '../master-data.handler.js';
import type { HandlerOutcome, MutationAction, MutationContext } from '../mutation.types.js';
import { prune, partialUpdateSchema } from './payload-helpers.js';

export const PAYMENT_ACCOUNT_KINDS = ['cash', 'bank', 'upi', 'card', 'wallet', 'other'] as const;

/**
 * Bounded, closed shape for `details` — human-readable reference metadata only
 * (e.g. "A/C ••3456 · HDFC0001234", a UPI ID, or a card's last 4). `.strict()`
 * rejects unknown keys so the offline sync-push path can't be used to stuff an
 * arbitrary blob into the column, and this same schema is imported by the REST
 * DTO so both write paths enforce identical bounds. NOT used in checkout
 * routing — display / reconciliation only. Structured per-kind fields can be
 * added here later (jsonb, no migration) once a feature actually reads them.
 */
export const PaymentAccountDetailsSchema = z
  .object({ reference: z.string().trim().max(140).optional() })
  .strict()
  .nullish();

const base = {
  name: z.string().min(1).max(60),
  kind: z.enum(PAYMENT_ACCOUNT_KINDS).optional(),
  details: PaymentAccountDetailsSchema,
  is_default: z.boolean().optional(),
  is_active: z.boolean().optional(),
};

const createSchema = z.object({ guuid: z.uuid(), ...base });
const updateSchema = partialUpdateSchema(base);

@Injectable()
export class PaymentAccountMutationHandler extends MasterDataSyncHandler {
  constructor(tombstones: TombstoneRepository) {
    super(
      {
        entityType: 'paymentaccount',
        permissionEntity: 'Payment',
        table: paymentAccounts,
        idColumn: paymentAccounts.id,
        guuidColumn: paymentAccounts.guuid,
        rowVersionColumn: paymentAccounts.rowVersion,
        storeFkColumn: paymentAccounts.storeFk,
        createSchema,
        updateSchema,
        // `is_system` / `system_key` are deliberately absent from the schemas and
        // this map — the client can never set them; only createStore seeding does
        // (DR-7). `name` is trimmed so "Cash " collides with "Cash" under the
        // lower(name) unique index (BR-3 / EC-2).
        mapColumns: (d, ctx, action) =>
          prune({
            name: typeof d.name === 'string' ? d.name.trim() : undefined,
            kind: d.kind,
            details: d.details,
            isDefault: d.is_default,
            isActive: d.is_active,
            ...(action === 'create' ? { createdBy: ctx.userId } : { updatedBy: ctx.userId }),
          }),
        deleteMode: { kind: 'deletedAt', column: paymentAccounts.deletedAt, byColumn: paymentAccounts.deletedBy },
      },
      tombstones,
    );
  }

  /**
   * Payment-account write rules layered over the generic master-data upsert
   * (PRD payment-accounts-mobile §BR-4 / §BR-8):
   *  - Seeds (`is_system`) can be renamed/edited but never deleted or
   *    deactivated.
   *  - At most one default per store: the prior default is cleared before the
   *    new one is set, so the write never trips `uk_payment_accounts_one_default`
   *    (the concurrency backstop). A rare transient zero-default is harmless —
   *    reads fall back to Cash (BR-9) — so no rollback dance is needed.
   */
  override async apply(
    action: MutationAction,
    payload: Record<string, unknown>,
    expectedRowVersion: number | undefined,
    ctx: MutationContext,
  ): Promise<HandlerOutcome> {
    const guuid = typeof payload.guuid === 'string' ? payload.guuid : null;

    // BR-4: a seeded (locked) account allows the is_default toggle AND its
    // `details` reference (so the owner can record their real Bank a/c number).
    // Delete and any change to name / kind / is_active are rejected — its name,
    // kind, system_key and is_system are immutable.
    const touchesProtected =
      action === 'delete' ||
      (action === 'update' &&
        (payload.name !== undefined ||
          payload.kind !== undefined ||
          payload.is_active !== undefined));
    if (guuid && touchesProtected) {
      const [live] = await ctx.tx
        .select({ isSystem: paymentAccounts.isSystem })
        .from(paymentAccounts)
        .where(and(eq(paymentAccounts.guuid, guuid), eq(paymentAccounts.storeFk, ctx.storeId)))
        .limit(1);
      if (live?.isSystem) {
        return {
          kind: 'rejected',
          code: ErrorCodes.PAYMENT_ACCOUNT_PROTECTED,
          message:
            action === 'delete'
              ? 'The default Cash and Bank accounts cannot be deleted.'
              : 'Cash and Bank are system accounts — only their default status and reference can be changed.',
          conflictType: 'BUSINESS_RULE',
        };
      }
    }

    // BR-8: clear the store's current default AFTER the optimistic-lock write
    // below is confirmed `applied`, never before. A `conflict` outcome is a
    // normal return (not a throw) whose nested SAVEPOINT still commits into
    // the outer tx, so clearing first would let the default-clear land even
    // when the row_version check lost the race and nothing else changed. Only
    // once `applied` is confirmed do we know the account is really becoming
    // (or staying) default, so re-derive the need to clear from the same
    // payload flag now that it's safe. row_version on the cleared account is
    // left to the sync_touch_row trigger so it re-pulls with is_default=false
    // on every device.
    const outcome = await super.apply(action, payload, expectedRowVersion, ctx);
    if (
      outcome.kind === 'applied' &&
      (action === 'create' || action === 'update') &&
      payload.is_default === true &&
      guuid
    ) {
      await ctx.tx
        .update(paymentAccounts)
        .set({ isDefault: false })
        .where(
          and(
            eq(paymentAccounts.storeFk, ctx.storeId),
            eq(paymentAccounts.isDefault, true),
            isNull(paymentAccounts.deletedAt),
            ne(paymentAccounts.guuid, guuid),
          ),
        );
    }

    return outcome;
  }
}