import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DRIZZLE, type DbExecutor } from '#db/db.module.js';
import * as schema from '#db/schema.js';
import { products } from '#db/schema.js';

/**
 * The `max_products` denominator (subscription.md §per-store limit) — kept
 * minimal and scoped to this one read since no products feature module/
 * repository exists yet (products are sync-only today).
 */
@Injectable()
export class ProductCountRepository {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>,
  ) {}

  async countActive(storeId: string, tx?: DbExecutor): Promise<number> {
    const [row] = await (tx ?? this.db)
      .select({ n: sql<number>`count(*)::int` })
      .from(products)
      .where(and(eq(products.storeFk, storeId), isNull(products.deletedAt)));
    return row?.n ?? 0;
  }

  /** Batched counterpart to `countActive` — one grouped query for every store
   *  in the set instead of N sequential per-store counts. */
  async countActiveByStores(storeIds: string[], tx?: DbExecutor): Promise<Map<string, number>> {
    if (storeIds.length === 0) return new Map();
    const rows = await (tx ?? this.db)
      .select({ storeFk: products.storeFk, n: sql<number>`count(*)::int` })
      .from(products)
      .where(and(inArray(products.storeFk, storeIds), isNull(products.deletedAt)))
      .groupBy(products.storeFk);
    return new Map(rows.map((r) => [r.storeFk, r.n]));
  }
}