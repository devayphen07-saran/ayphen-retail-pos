import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { customers, lookup } from '#db/schema.js';
import { TombstoneRepository } from '../../repositories/tombstone.repository.js';
import { MasterDataSyncHandler } from '../master-data.handler.js';
import {
  money,
  prune,
  partialUpdateSchema,
  gstin,
  pan,
  pinCode,
  paymentTermDays,
} from './payload-helpers.js';

const base = {
  name: z.string().min(1).max(200),
  phone: z.string().max(20).nullish(),
  email: z.string().max(255).nullish(),
  website: z.string().max(255).nullish(),
  logo_uri: z.string().max(1024).nullish(),
  gst_number: gstin.nullish(),
  pan_number: pan.nullish(),
  credit_limit: money.nullish(),
  override_credit_limit: z.boolean().optional(),
  payment_term_days: paymentTermDays.nullish(),
  address_line_1: z.string().max(100).nullish(),
  address_line_2: z.string().max(100).nullish(),
  city: z.string().max(50).nullish(),
  district: z.string().max(50).nullish(),
  pin_code: pinCode.nullish(),
  birthday: z.string().max(10).nullish(),
  anniversary: z.string().max(10).nullish(),
  notes: z.string().max(250).nullish(),
  is_active: z.boolean().optional(),
  customer_type_lookup_guuid: z.uuid().nullish(),
  payment_term_lookup_guuid: z.uuid().nullish(),
  state_lookup_guuid: z.uuid().nullish(),
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
            website: d.website,
            logoUri: d.logo_uri,
            gstNumber: d.gst_number,
            panNumber: d.pan_number,
            creditLimit: d.credit_limit,
            overrideCreditLimit: d.override_credit_limit,
            paymentTermDays: d.payment_term_days,
            addressLine1: d.address_line_1,
            addressLine2: d.address_line_2,
            city: d.city,
            district: d.district,
            pinCode: d.pin_code,
            birthday: d.birthday,
            anniversary: d.anniversary,
            notes: d.notes,
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
          {
            field: 'payment_term_lookup_guuid',
            column: 'paymentTermLookupFk',
            table: lookup,
            matchOn: lookup.guuid,
            idColumn: lookup.id,
            scope: 'globalOrStore',
            storeFkColumn: lookup.storeFk,
          },
          {
            field: 'state_lookup_guuid',
            column: 'stateLookupFk',
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
