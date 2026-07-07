import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { customers, lookup } from '#db/schema.js';
import { TombstoneRepository } from '../../repositories/tombstone.repository.js';
import { MasterDataSyncHandler } from '../master-data.handler.js';
import { money, prune, partialUpdateSchema } from './payload-helpers.js';

const base = {
  name: z.string().min(1).max(200),
  phone: z.string().max(20).nullish(),
  email: z.string().max(255).nullish(),
  gst_number: z.string().max(20).nullish(),
  credit_limit: money.nullish(),
  is_active: z.boolean().optional(),
  customer_type_lookup_guuid: z.uuid().nullish(),
};

const createSchema = z.object({ guuid: z.uuid(), ...base });
const updateSchema = partialUpdateSchema(base);

@Injectable()
export class CustomerMutationHandler extends MasterDataSyncHandler {
  constructor(tombstones: TombstoneRepository) {
    super(
      {
        entityType: 'customer',
        permissionEntity: 'Customer',
        table: customers,
        idColumn: customers.id,
        guuidColumn: customers.guuid,
        rowVersionColumn: customers.rowVersion,
        storeFkColumn: customers.storeFk,
        createSchema,
        updateSchema,
        mapColumns: (d, ctx, action) =>
          prune({
            name: d.name,
            phone: d.phone,
            email: d.email,
            gstNumber: d.gst_number,
            creditLimit: d.credit_limit,
            isActive: d.is_active,
            ...(action === 'create' ? { createdBy: ctx.userId } : { updatedBy: ctx.userId }),
          }),
        fkResolvers: [
          {
            field: 'customer_type_lookup_guuid',
            column: 'customerTypeLookupFk',
            table: lookup,
            matchOn: lookup.guuid,
            idColumn: lookup.id,
            scope: 'globalOrStore',
            storeFkColumn: lookup.storeFk,
          },
        ],
        deleteMode: { kind: 'deletedAt', column: customers.deletedAt, byColumn: customers.deletedBy },
      },
      tombstones,
    );
  }
}
