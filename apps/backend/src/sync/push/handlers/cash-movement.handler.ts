import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { and, eq, isNull } from 'drizzle-orm';
import { ErrorCodes } from '#common/error-codes.js';
import { cashMovements, paymentAccounts } from '#db/schema.js';
import { AccountPostingService } from '../../../ledger/account-posting.service.js';
import { AppendOnlySyncHandler } from '../append-only.handler.js';
import type { HandlerOutcome, MutationContext } from '../mutation.types.js';

const CASH_MOVEMENT_TYPES = ['payin', 'payout', 'drop', 'tip'] as const;

const createSchema = z
  .object({
    guuid: z.uuid(),
    account_guuid: z.uuid(),
    type: z.enum(CASH_MOVEMENT_TYPES),
    reason: z.string().trim().max(280).nullish(),
    amount_paise: z.number().int().positive('Enter an amount greater than ₹0.'),
  })
  // BR-7 / V-7: payout and drop must carry a reason.
  .superRefine((data, ctx) => {
    if ((data.type === 'payout' || data.type === 'drop') && !data.reason) {
      ctx.addIssue({
        code: 'custom',
        path: ['reason'],
        message: 'Add a reason for this cash-out.',
      });
    }
  });

/**
 * Manual cash in/out (docs/prd/accounts-and-ledger.md F4). Append-only:
 * corrections are new movements, never edits. Posts its own
 * `account_transactions` row via AccountPostingService in the SAME
 * transaction as the insert (D1/SD-1) — a client can never author a posting
 * directly (BR-3).
 */
@Injectable()
export class CashMovementMutationHandler extends AppendOnlySyncHandler {
  constructor(private readonly posting: AccountPostingService) {
    super({
      entityType: 'cash_movement',
      permissionEntity: 'CashMovement',
      table: cashMovements,
      idColumn: cashMovements.id,
      guuidColumn: cashMovements.guuid,
      storeFkColumn: cashMovements.storeFk,
      createSchema,
      mapColumns: (d, ctx) => ({
        type: d.type,
        reason: d.reason ?? null,
        amountPaise: d.amount_paise,
        byUserFk: ctx.userId,
      }),
      fkResolvers: [
        {
          field: 'account_guuid',
          column: 'accountFk',
          table: paymentAccounts,
          matchOn: paymentAccounts.guuid,
          idColumn: paymentAccounts.id,
          scope: 'store',
          storeFkColumn: paymentAccounts.storeFk,
        },
      ],
      onInserted: (row, ctx) => this.onInserted(row, ctx),
    });
  }

  private async onInserted(
    row: Record<string, unknown>,
    ctx: MutationContext,
  ): Promise<HandlerOutcome | null> {
    const accountFk = row.accountFk as string;

    // V-2 / EF-9: the resolved account must still be active. Checked here
    // (post-insert, pre-commit) rather than duplicating the fkResolver query —
    // a rejection here rolls back the whole business transaction, so nothing
    // persists either way.
    const [account] = await ctx.tx
      .select({ isActive: paymentAccounts.isActive, deletedAt: paymentAccounts.deletedAt })
      .from(paymentAccounts)
      .where(and(eq(paymentAccounts.id, accountFk), isNull(paymentAccounts.deletedAt)))
      .limit(1);
    if (!account || !account.isActive) {
      return {
        kind: 'rejected',
        code: ErrorCodes.ACCOUNT_INACTIVE,
        message: "This account is inactive and can't be used.",
        conflictType: 'BUSINESS_RULE',
      };
    }

    await this.posting.postCashMovement(
      ctx.tx,
      {
        id: row.id as string,
        storeFk: row.storeFk as string,
        accountFk,
        type: row.type as 'payin' | 'payout' | 'drop' | 'tip',
        amountPaise: row.amountPaise as number,
      },
      ctx,
    );
    return null;
  }
}