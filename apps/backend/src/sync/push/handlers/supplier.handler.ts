import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { suppliers } from '#db/schema.js';
import { TombstoneRepository } from '../../repositories/tombstone.repository.js';
import { MasterDataSyncHandler } from '../master-data.handler.js';
import { prune } from './payload-helpers.js';

const base = {
  name: z.string().min(1).max(200),
  phone: z.string().max(20).nullish(),
  email: z.string().max(255).nullish(),
  gst_number: z.string().max(20).nullish(),
  is_active: z.boolean().optional(),
};

const createSchema = z.object({ guuid: z.uuid(), ...base });
const updateSchema = z.object({
  guuid: z.uuid(),
  ...Object.fromEntries(
    Object.entries(base).map(([k, s]) => [k, (s as z.ZodType).optional()]),
  ),
}) as z.ZodType<Record<string, unknown>>;

@Injectable()
export class SupplierMutationHandler extends MasterDataSyncHandler {
  constructor(tombstones: TombstoneRepository) {
    super(
      {
        entityType: 'supplier',
        permissionEntity: 'Supplier',
        table: suppliers,
        idColumn: suppliers.id,
        guuidColumn: suppliers.guuid,
        rowVersionColumn: suppliers.rowVersion,
        storeFkColumn: suppliers.storeFk,
        createSchema,
        updateSchema,
        mapColumns: (d, ctx, action) =>
          prune({
            name: d.name,
            phone: d.phone,
            email: d.email,
            gstNumber: d.gst_number,
            isActive: d.is_active,
            ...(action === 'create' ? { createdBy: ctx.userId } : { updatedBy: ctx.userId }),
          }),
        deleteMode: { kind: 'deletedAt', column: suppliers.deletedAt, byColumn: suppliers.deletedBy },
      },
      tombstones,
    );
  }
}
