import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { paymentAccounts, paymentMethods } from '#db/schema.js';
import { TombstoneRepository } from '../../repositories/tombstone.repository.js';
import { MasterDataSyncHandler } from '../master-data.handler.js';
import { prune, partialUpdateSchema } from './payload-helpers.js';

const base = {
  name: z.string().min(1).max(200),
  payment_method_guuid: z.uuid().nullish(),
  details: z.record(z.string(), z.unknown()).nullish(),
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
        mapColumns: (d, ctx, action) =>
          prune({
            name: d.name,
            details: d.details,
            isDefault: d.is_default,
            isActive: d.is_active,
            ...(action === 'create' ? { createdBy: ctx.userId } : { updatedBy: ctx.userId }),
          }),
        fkResolvers: [
          {
            field: 'payment_method_guuid',
            column: 'paymentMethodFk',
            table: paymentMethods,
            matchOn: paymentMethods.guuid,
            idColumn: paymentMethods.id,
            scope: 'store',
            storeFkColumn: paymentMethods.storeFk,
          },
        ],
        deleteMode: { kind: 'deletedAt', column: paymentAccounts.deletedAt, byColumn: paymentAccounts.deletedBy },
      },
      tombstones,
    );
  }
}