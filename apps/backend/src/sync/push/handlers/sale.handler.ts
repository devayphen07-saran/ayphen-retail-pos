import { Injectable } from '@nestjs/common';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';

import { ErrorCodes } from '#common/error-codes.js';
import {
  customerLedgerEvents,
  customers,
  paymentAccounts,
  products,
  saleLines,
  salePayments,
  sales,
  stores,
} from '#db/schema.js';

import { AccountPostingService } from '../../../ledger/account-posting.service.js';
import { SyncWireMapper } from '../../mappers/response/sync-wire.mapper.js';
import type { SyncEntityType } from '../../sync.constants.js';
import type {
  HandlerOutcome,
  MutationAction,
  MutationContext,
  SyncMutationHandler,
} from '../mutation.types.js';

const TENDERS = ['cash', 'card', 'upi', 'wallet', 'other'] as const;

const paiseSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

const positivePaiseSchema = paiseSchema.refine((value) => value > 0, {
  message: 'Amount must be greater than zero.',
});

const quantitySchema = z
  .number()
  .positive()
  .refine(
    (value) => {
      const scaled = value * 1_000;

      return (
        Number.isSafeInteger(Math.round(scaled)) &&
        Math.abs(scaled - Math.round(scaled)) < 1e-9
      );
    },
    {
      message: 'Quantity can have at most three decimal places.',
    },
  );

const lineSchema = z.object({
  product_guuid: z.string().uuid(),
  qty: quantitySchema,
  unit_price_paise: paiseSchema,
  discount_paise: paiseSchema.optional(),
});

const paymentSchema = z
  .object({
    account_guuid: z.string().uuid().optional(),
    tender: z.enum(TENDERS),
    amount_paise: positivePaiseSchema,
    on_credit: z.boolean().optional().default(false),
  })
  .superRefine((payment, ctx) => {
    if (payment.on_credit && payment.account_guuid) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['account_guuid'],
        message: 'A credit payment must not have an account.',
      });
    }

    if (!payment.on_credit && !payment.account_guuid) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['account_guuid'],
        message: 'Select an account for this payment.',
      });
    }
  });

const createSchema = z
  .object({
    guuid: z.string().uuid(),
    customer_guuid: z.string().uuid().optional(),
    lines: z.array(lineSchema).min(1, 'A sale needs at least one item.'),
    payments: z
      .array(paymentSchema)
      .min(1, 'A sale needs at least one payment.'),
  })
  .superRefine((data, ctx) => {
    const creditPayments = data.payments.filter((payment) => payment.on_credit);

    if (creditPayments.length > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['payments'],
        message: 'A sale can have only one credit payment portion.',
      });
    }

    if (creditPayments.length > 0 && !data.customer_guuid) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['customer_guuid'],
        message: 'Select a customer to sell on credit.',
      });
    }

    data.lines.forEach((line, index) => {
      const grossPaise = Math.round(line.qty * line.unit_price_paise);
      const discountPaise = line.discount_paise ?? 0;

      if (!Number.isSafeInteger(grossPaise)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['lines', index],
          message: 'The calculated line amount is too large.',
        });
      }

      if (discountPaise > grossPaise) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['lines', index, 'discount_paise'],
          message: 'Discount cannot exceed the line amount.',
        });
      }
    });
  });

const rejected = (
  code: (typeof ErrorCodes)[keyof typeof ErrorCodes],
  message: string,
): HandlerOutcome => ({
  kind: 'rejected',
  code,
  message,
  conflictType: 'VALIDATION',
});

/**
 * `customers.credit_limit` is a NUMERIC(12,2) rupee string.
 * Null, empty, zero, or an invalid value is treated as unlimited.
 */
function creditLimitPaise(raw: string | null): number {
  if (!raw) {
    return 0;
  }

  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(raw.trim());

  if (!match) {
    return 0;
  }

  const rupees = Number(match[1]);
  const fractionalPart = (match[2] ?? '').padEnd(2, '0');
  const paise = Number(fractionalPart);
  const total = rupees * 100 + paise;

  return Number.isSafeInteger(total) ? total : 0;
}

/**
 * Handles a sale as one composite, append-only mutation containing its header,
 * lines and payments.
 *
 * A completed sale cannot be updated or deleted. Corrections are performed
 * through the refund flow.
 */
@Injectable()
export class SaleMutationHandler implements SyncMutationHandler {
  readonly entityType: SyncEntityType = 'sale';
  readonly permissionEntity = 'Sale' as const;

  constructor(private readonly posting: AccountPostingService) {}

  async apply(
    action: MutationAction,
    payload: Record<string, unknown>,
    _expectedRowVersion: number | undefined,
    ctx: MutationContext,
  ): Promise<HandlerOutcome> {
    if (action !== 'create') {
      return rejected(
        ErrorCodes.VALIDATION_FAILED,
        'A sale is append-only. Reverse or correct it through a refund.',
      );
    }

    const parsed = createSchema.safeParse(payload);

    if (!parsed.success) {
      const detail = parsed.error.issues
        .slice(0, 5)
        .map((issue) =>
          issue.path.length > 0
            ? `${issue.path.join('.')}: ${issue.message}`
            : issue.message,
        )
        .join('; ');

      return rejected(
        ErrorCodes.VALIDATION_FAILED,
        detail || 'Invalid sale payload.',
      );
    }

    const data = parsed.data;

    const productGuuids = [
      ...new Set(data.lines.map((line) => line.product_guuid)),
    ];

    const accountGuuids = [
      ...new Set(
        data.payments
          .map((payment) => payment.account_guuid)
          .filter((guuid): guuid is string => guuid !== undefined),
      ),
    ];

    const [productRows, accountRows, customerRows] = await Promise.all([
      ctx.tx
        .select({
          id: products.id,
          guuid: products.guuid,
        })
        .from(products)
        .where(
          and(
            eq(products.storeFk, ctx.storeId),
            inArray(products.guuid, productGuuids),
            isNull(products.deletedAt),
          ),
        ),

      accountGuuids.length > 0
        ? ctx.tx
            .select({
              id: paymentAccounts.id,
              guuid: paymentAccounts.guuid,
              isActive: paymentAccounts.isActive,
            })
            .from(paymentAccounts)
            .where(
              and(
                eq(paymentAccounts.storeFk, ctx.storeId),
                inArray(paymentAccounts.guuid, accountGuuids),
                isNull(paymentAccounts.deletedAt),
              ),
            )
        : Promise.resolve([]),

      data.customer_guuid
        ? ctx.tx
            .select({
              id: customers.id,
              creditLimit: customers.creditLimit,
              overrideCreditLimit: customers.overrideCreditLimit,
            })
            .from(customers)
            .where(
              and(
                eq(customers.storeFk, ctx.storeId),
                eq(customers.guuid, data.customer_guuid),
                isNull(customers.deletedAt),
              ),
            )
            .limit(1)
        : Promise.resolve([]),
    ]);

    const productIdByGuuid = new Map(
      productRows.map((product) => [product.guuid, product.id]),
    );

    for (const guuid of productGuuids) {
      if (!productIdByGuuid.has(guuid)) {
        return rejected(
          ErrorCodes.VALIDATION_FAILED,
          `Unknown product: ${guuid}`,
        );
      }
    }

    const accountByGuuid = new Map(
      accountRows.map((account) => [account.guuid, account]),
    );

    for (const guuid of accountGuuids) {
      const account = accountByGuuid.get(guuid);

      if (!account) {
        return rejected(
          ErrorCodes.VALIDATION_FAILED,
          `Unknown payment account: ${guuid}`,
        );
      }

      if (!account.isActive) {
        return {
          kind: 'rejected',
          code: ErrorCodes.ACCOUNT_INACTIVE,
          message: "This account is inactive and can't be used.",
          conflictType: 'BUSINESS_RULE',
        };
      }
    }

    let customerFk: string | null = null;
    let customerCreditLimit: string | null = null;
    let customerOverride = false;

    if (data.customer_guuid) {
      const customer = customerRows[0];

      if (!customer) {
        return {
          kind: 'rejected',
          code: ErrorCodes.CUSTOMER_NOT_FOUND,
          message: 'This customer could not be found.',
          conflictType: 'BUSINESS_RULE',
        };
      }

      customerFk = customer.id;
      customerCreditLimit = customer.creditLimit;
      customerOverride = customer.overrideCreditLimit ?? false;
    }

    const lineValues = data.lines.map((line) => {
      const discountPaise = line.discount_paise ?? 0;
      const grossPaise = Math.round(line.qty * line.unit_price_paise);

      return {
        productFk: productIdByGuuid.get(line.product_guuid)!,
        qty: String(line.qty),
        unitPricePaise: line.unit_price_paise,
        discountPaise,
        lineTotalPaise: grossPaise - discountPaise,
      };
    });

    const totalPaise = lineValues.reduce(
      (sum, line) => sum + line.lineTotalPaise,
      0,
    );

    if (!Number.isSafeInteger(totalPaise)) {
      return rejected(
        ErrorCodes.VALIDATION_FAILED,
        'The calculated sale total is too large.',
      );
    }

    if (totalPaise <= 0) {
      return rejected(
        ErrorCodes.VALIDATION_FAILED,
        'Cart total must be greater than ₹0.',
      );
    }

    const paymentsSum = data.payments.reduce(
      (sum, payment) => sum + payment.amount_paise,
      0,
    );

    if (!Number.isSafeInteger(paymentsSum) || paymentsSum !== totalPaise) {
      return {
        kind: 'rejected',
        code: ErrorCodes.PAYMENT_MISMATCH,
        message: "Payment doesn't add up to the total.",
        conflictType: 'VALIDATION',
      };
    }

    const creditPortionPaise = data.payments
      .filter((payment) => payment.on_credit)
      .reduce((sum, payment) => sum + payment.amount_paise, 0);

    const [storeRow] = await ctx.tx
      .update(stores)
      .set({
        invoiceCounter: sql`${stores.invoiceCounter} + 1`,
      })
      .where(eq(stores.id, ctx.storeId))
      .returning({
        invoiceCounter: stores.invoiceCounter,
        invoicePrefix: stores.invoicePrefix,
      });

    if (!storeRow) {
      throw new Error(
        `Cannot allocate an invoice number: store ${ctx.storeId} was not found.`,
      );
    }

    if (!storeRow.invoicePrefix) {
      throw new Error(
        `Cannot allocate an invoice number: store ${ctx.storeId} has no invoice prefix.`,
      );
    }

    const invoiceNo = `${storeRow.invoicePrefix}-${storeRow.invoiceCounter}`;

    const [sale] = await ctx.tx
      .insert(sales)
      .values({
        storeFk: ctx.storeId,
        guuid: data.guuid,
        customerFk,
        totalPaise,
        invoiceNo,
        createdBy: ctx.userId,
        deviceFk: ctx.deviceId,
      })
      .returning();

    if (!sale) {
      throw new Error('Sale insert did not return the created row.');
    }

    await ctx.tx.insert(saleLines).values(
      lineValues.map((line) => ({
        storeFk: ctx.storeId,
        saleFk: sale.id,
        ...line,
      })),
    );

    const insertedPayments = await ctx.tx
      .insert(salePayments)
      .values(
        data.payments.map((payment) => ({
          storeFk: ctx.storeId,
          saleFk: sale.id,
          accountFk: payment.on_credit
            ? null
            : accountByGuuid.get(payment.account_guuid!)!.id,
          tender: payment.tender,
          amountPaise: payment.amount_paise,
          onCredit: payment.on_credit,
        })),
      )
      .returning();

    for (const payment of insertedPayments) {
      if (payment.onCredit) {
        continue;
      }

      if (!payment.accountFk) {
        throw new Error(`Sale payment ${payment.id} has no payment account.`);
      }

      await this.posting.postSalePayment(
        ctx.tx,
        {
          storeFk: ctx.storeId,
          accountFk: payment.accountFk,
          amountPaise: payment.amountPaise,
          salePaymentId: payment.id,
        },
        ctx,
      );
    }

    if (creditPortionPaise > 0) {
      if (!customerFk) {
        throw new Error('A credit sale reached posting without a customer.');
      }

      const [outstandingRow] = await ctx.tx
        .select({
          total: sql<string>`
            coalesce(
              sum(${customerLedgerEvents.amountPaise})
                filter (
                  where ${customerLedgerEvents.kind} = 'credit_sale'
                ),
              0
            )
            -
            coalesce(
              sum(${customerLedgerEvents.amountPaise})
                filter (
                  where ${customerLedgerEvents.kind}
                    in ('payment', 'credit_note')
                ),
              0
            )
          `,
        })
        .from(customerLedgerEvents)
        .where(
          and(
            eq(customerLedgerEvents.storeFk, ctx.storeId),
            eq(customerLedgerEvents.customerFk, customerFk),
          ),
        );

      const currentOutstanding = Number(outstandingRow?.total ?? 0);

      if (!Number.isSafeInteger(currentOutstanding)) {
        throw new Error(
          `Invalid outstanding balance for customer ${customerFk}.`,
        );
      }

      const limitPaise = creditLimitPaise(customerCreditLimit);
      const projectedOutstanding = currentOutstanding + creditPortionPaise;

      if (!Number.isSafeInteger(projectedOutstanding)) {
        throw new Error(
          `Projected outstanding balance is too large for customer ${customerFk}.`,
        );
      }

      const exceeded =
        !customerOverride &&
        limitPaise > 0 &&
        projectedOutstanding > limitPaise;

      await this.posting.postCreditSale(
        ctx.tx,
        {
          storeFk: ctx.storeId,
          customerFk,
          amountPaise: creditPortionPaise,
          saleId: sale.id,
          flagged: exceeded,
        },
        ctx,
      );
    }

    return {
      kind: 'applied',
      entityId: sale.id,
      entityGuuid: sale.guuid,
      data: SyncWireMapper.toAppliedRow(sale as Record<string, unknown>),
    };
  }
}
