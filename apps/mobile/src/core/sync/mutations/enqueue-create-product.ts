import * as Crypto from 'expo-crypto';
import { ulid } from './ulid';
import { getSyncDb } from '../db/client';
import { withTransaction } from '../db/transaction';
import { productRepository } from '../repositories/product.repository';
import { mutationQueueRepository } from '../repositories/mutation-queue.repository';
import { requestImmediateSync } from '../scheduler-instance';

export interface CreateProductInput {
  name: string;
  sku?: string;
  barcode?: string;
  sellingPrice: string; // canonical "12.34"-style string (payload-helpers.ts `money`)
  costPrice?: string;
  mrp?: string;
  hsnCode?: string;
  trackInventory?: boolean;
}

/**
 * Optimistic create (mobile-11 §6.1): write the local row + enqueue the
 * mutation in ONE transaction — the durable "one tx" rule applies to writes
 * exactly as it does to pulls (a crash between the two must not leave a
 * queued mutation with no local row to show for it, or vice versa).
 *
 * The temp local `id` is the client-generated `guuid` — there is no server id
 * yet. Once `applied` comes back, drain-queue.ts's commit-applied handling
 * deletes this temp row (by guuid) and inserts the authoritative one under
 * the server's real id.
 */
export async function enqueueCreateProduct(storeId: string, input: CreateProductInput): Promise<string> {
  const guuid = Crypto.randomUUID();
  const mutationId = ulid();
  const now = new Date().toISOString();

  const db = getSyncDb();
  await withTransaction(db, async (tx) => {
    await productRepository.upsertAll(tx, storeId, [
      {
        id: guuid,
        guuid,
        name: input.name,
        sku: input.sku ?? null,
        barcode: input.barcode ?? null,
        category_lookup_fk: null,
        unit_fk: null,
        taxrate_fk: null,
        selling_price: input.sellingPrice,
        cost_price: input.costPrice ?? null,
        mrp: input.mrp ?? null,
        hsn_code: input.hsnCode ?? null,
        track_inventory: input.trackInventory ?? null,
        is_active: true,
        row_version: 0, // placeholder — overwritten once the server confirms
        modified_at: now,
      },
    ]);

    await mutationQueueRepository.enqueue(tx, {
      mutationId,
      storeId,
      entityType: 'product',
      entityGuuid: guuid,
      action: 'create',
      payload: {
        guuid,
        name: input.name,
        sku: input.sku,
        barcode: input.barcode,
        selling_price: input.sellingPrice,
        cost_price: input.costPrice,
        mrp: input.mrp,
        hsn_code: input.hsnCode,
        track_inventory: input.trackInventory,
      },
      clientModifiedAt: now,
      now,
    });
  });

  requestImmediateSync();
  return guuid;
}
