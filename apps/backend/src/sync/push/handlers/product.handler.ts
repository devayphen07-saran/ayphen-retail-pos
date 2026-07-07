import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { lookup, productCases, products, taxRates, units } from '#db/schema.js';
import { TombstoneRepository } from '../../repositories/tombstone.repository.js';
import { MasterDataSyncHandler } from '../master-data.handler.js';
import { money, prune, quantity, partialUpdateSchema } from './payload-helpers.js';

const productBase = {
  name: z.string().min(1).max(200),
  sku: z.string().max(64).nullish(),
  barcode: z.string().max(64).nullish(),
  selling_price: money,
  cost_price: money.nullish(),
  mrp: money.nullish(),
  hsn_code: z.string().max(16).nullish(),
  track_inventory: z.boolean().optional(),
  is_active: z.boolean().optional(),
  unit_guuid: z.uuid().nullish(),
  taxrate_guuid: z.uuid().nullish(),
  category_lookup_guuid: z.uuid().nullish(),
};

const createSchema = z.object({ guuid: z.uuid(), ...productBase });
const updateSchema = partialUpdateSchema(productBase);

@Injectable()
export class ProductMutationHandler extends MasterDataSyncHandler {
  constructor(tombstones: TombstoneRepository) {
    super(
      {
        entityType: 'product',
        permissionEntity: 'Product',
        table: products,
        idColumn: products.id,
        guuidColumn: products.guuid,
        rowVersionColumn: products.rowVersion,
        storeFkColumn: products.storeFk,
        createSchema,
        updateSchema,
        mapColumns: (d, ctx, action) =>
          prune({
            name: d.name,
            sku: d.sku,
            barcode: d.barcode,
            sellingPrice: d.selling_price,
            costPrice: d.cost_price,
            mrp: d.mrp,
            hsnCode: d.hsn_code,
            trackInventory: d.track_inventory,
            isActive: d.is_active,
            ...(action === 'create' ? { createdBy: ctx.userId } : { updatedBy: ctx.userId }),
          }),
        fkResolvers: [
          {
            field: 'unit_guuid',
            column: 'unitFk',
            table: units,
            matchOn: units.guuid,
            idColumn: units.id,
            scope: 'store',
            storeFkColumn: units.storeFk,
          },
          {
            field: 'taxrate_guuid',
            column: 'taxrateFk',
            table: taxRates,
            matchOn: taxRates.guuid,
            idColumn: taxRates.id,
            scope: 'store',
            storeFkColumn: taxRates.storeFk,
          },
          {
            field: 'category_lookup_guuid',
            column: 'categoryLookupFk',
            table: lookup,
            matchOn: lookup.guuid,
            idColumn: lookup.id,
            scope: 'globalOrStore',
            storeFkColumn: lookup.storeFk,
          },
        ],
        deleteMode: { kind: 'deletedAt', column: products.deletedAt, byColumn: products.deletedBy },
      },
      tombstones,
    );
  }
}

const caseBase = {
  product_guuid: z.uuid(),
  name: z.string().min(1).max(100),
  quantity: quantity,
  barcode: z.string().max(64).nullish(),
  selling_price: money.nullish(),
  is_active: z.boolean().optional(),
};

const caseCreateSchema = z.object({ guuid: z.uuid(), ...caseBase });
const caseUpdateSchema = partialUpdateSchema(caseBase);

@Injectable()
export class ProductCaseMutationHandler extends MasterDataSyncHandler {
  constructor(tombstones: TombstoneRepository) {
    super(
      {
        entityType: 'product_case',
        permissionEntity: 'Product',
        table: productCases,
        idColumn: productCases.id,
        guuidColumn: productCases.guuid,
        rowVersionColumn: productCases.rowVersion,
        storeFkColumn: productCases.storeFk,
        createSchema: caseCreateSchema,
        updateSchema: caseUpdateSchema,
        mapColumns: (d, ctx, action) =>
          prune({
            name: d.name,
            quantity: d.quantity,
            barcode: d.barcode,
            sellingPrice: d.selling_price,
            isActive: d.is_active,
            ...(action === 'create' ? { createdBy: ctx.userId } : { updatedBy: ctx.userId }),
          }),
        fkResolvers: [
          {
            field: 'product_guuid',
            column: 'productFk',
            table: products,
            matchOn: products.guuid,
            idColumn: products.id,
            scope: 'store',
            storeFkColumn: products.storeFk,
          },
        ],
        deleteMode: { kind: 'deletedAt', column: productCases.deletedAt, byColumn: productCases.deletedBy },
      },
      tombstones,
    );
  }
}
