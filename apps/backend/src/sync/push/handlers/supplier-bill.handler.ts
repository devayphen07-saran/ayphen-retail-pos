import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { supplierBills, suppliers } from '#db/schema.js';
import { AppendOnlySyncHandler } from '../append-only.handler.js';

const createSchema = z.object({
  guuid: z.uuid(),
  supplier_guuid: z.uuid(),
  bill_no: z.string().trim().max(60).optional(),
  amount_paise: z.number().int().positive('Enter an amount greater than ₹0.'),
  bill_date: z.iso.datetime().optional(),
  due_date: z.iso.datetime().optional(),
  notes: z.string().trim().max(280).optional(),
});

/**
 * F6 (docs/prd/accounts-and-ledger.md) — recording what a vendor billed us.
 * Flat append-only create (no lines, unlike a sale — nothing here computes
 * tax/inventory from it). `status` starts 'open' and is only ever moved by
 * supplier-payment.handler.ts, never by a generic update to this entity.
 */
@Injectable()
export class SupplierBillMutationHandler extends AppendOnlySyncHandler {
  constructor() {
    super({
      entityType: 'supplier_bill',
      permissionEntity: 'SupplierBill',
      table: supplierBills,
      idColumn: supplierBills.id,
      guuidColumn: supplierBills.guuid,
      storeFkColumn: supplierBills.storeFk,
      createSchema,
      mapColumns: (d, ctx) => ({
        billNo: d.bill_no ?? null,
        amountPaise: d.amount_paise,
        billDate: d.bill_date ? new Date(d.bill_date as string) : undefined,
        dueDate: d.due_date ? new Date(d.due_date as string) : null,
        notes: d.notes ?? null,
        createdBy: ctx.userId,
      }),
      fkResolvers: [
        {
          field: 'supplier_guuid',
          column: 'supplierFk',
          table: suppliers,
          matchOn: suppliers.guuid,
          idColumn: suppliers.id,
          scope: 'store',
          storeFkColumn: suppliers.storeFk,
        },
      ],
    });
  }
}