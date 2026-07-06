import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { lookup, lookupType } from '#db/schema.js';
import { ErrorCodes } from '#common/error-codes.js';
import { TombstoneRepository } from '../../repositories/tombstone.repository.js';
import { MasterDataSyncHandler } from '../master-data.handler.js';
import { prune } from './payload-helpers.js';

const createSchema = z.object({
  guuid: z.uuid(),
  lookup_type_code: z.string().min(1).max(40),
  code: z.string().min(1).max(40),
  label: z.string().min(1).max(80),
  description: z.string().max(200).nullish(),
  sort_order: z.number().int().optional(),
  is_hidden: z.boolean().optional(),
});

// `code` and the type are immutable after create (D3 uniqueness); only display
// fields rebase through the optimistic lock.
const updateSchema = z.object({
  guuid: z.uuid(),
  label: z.string().min(1).max(80).optional(),
  description: z.string().max(200).nullish(),
  sort_order: z.number().int().optional(),
  is_hidden: z.boolean().optional(),
});

@Injectable()
export class LookupMutationHandler extends MasterDataSyncHandler {
  constructor(tombstones: TombstoneRepository) {
    super(
      {
        entityType: 'lookup',
        permissionEntity: 'Lookup',
        table: lookup,
        idColumn: lookup.id,
        guuidColumn: lookup.guuid,
        rowVersionColumn: lookup.rowVersion,
        // Client mutations only ever touch store-custom rows — global values
        // (store_fk NULL) are unreachable through the store-scoped where and
        // come back NOT_FOUND (BR-2: staff never edit shared reference data).
        storeFkColumn: lookup.storeFk,
        createSchema,
        updateSchema,
        mapColumns: (d, ctx, action) =>
          prune({
            code: d.code,
            label: d.label,
            description: d.description,
            sortOrder: d.sort_order,
            isHidden: d.is_hidden,
            ...(action === 'create' ? { createdBy: ctx.userId } : { updatedBy: ctx.userId }),
          }),
        fkResolvers: [
          {
            field: 'lookup_type_code',
            column: 'lookupTypeFk',
            table: lookupType,
            matchOn: lookupType.code,
            idColumn: lookupType.id,
            scope: 'global',
          },
        ],
        deleteMode: { kind: 'isActive', column: lookup.isActive },
        guardRow: (row) =>
          row.isSystem === true
            ? {
                kind: 'rejected',
                code: ErrorCodes.LOOKUP_VALUE_PROTECTED,
                message: 'system lookup values cannot be edited or deleted',
                conflictType: 'BUSINESS_RULE',
              }
            : null,
      },
      tombstones,
    );
  }
}
