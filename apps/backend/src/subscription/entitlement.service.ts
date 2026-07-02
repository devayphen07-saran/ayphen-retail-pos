import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DRIZZLE, type DbExecutor } from '../db/db.module.js';
import * as schema from '../db/schema.js';
import {
  accountSubscriptions,
  planEntitlements,
  planFeatures,
} from '../db/schema.js';

/** Known entitlement keys (plan_entitlements.key). Integer value; null = unlimited. */
export type EntitlementKey =
  | 'max_stores'
  | 'max_locations_per_store'
  | 'max_devices_per_store'
  | 'max_users_per_store'
  | 'max_products';

/**
 * Reads plan limits/features for an account (subscription §3, §26.6). The lookup
 * chain is account → account_subscription → plan → plan_entitlements/plan_features.
 * Enforcement uses strict less-than: currentCount < limit (null = unlimited).
 */
@Injectable()
export class EntitlementService {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>,
  ) {}

  /** Entitlement integer for an account, or null (= unlimited / no row). */
  async get(
    accountId: string,
    key: EntitlementKey,
    tx?: DbExecutor,
  ): Promise<number | null> {
    const client = tx ?? this.db;
    const [row] = await client
      .select({ value: planEntitlements.value })
      .from(accountSubscriptions)
      .innerJoin(planEntitlements, eq(planEntitlements.planFk, accountSubscriptions.planFk))
      .where(
        and(
          eq(accountSubscriptions.accountFk, accountId),
          eq(planEntitlements.key, key),
        ),
      );
    return row?.value ?? null;
  }

  /** Boolean feature flag for an account (plan_features). Missing row = false. */
  async feature(accountId: string, key: string, tx?: DbExecutor): Promise<boolean> {
    const client = tx ?? this.db;
    const [row] = await client
      .select({ enabled: planFeatures.enabled })
      .from(accountSubscriptions)
      .innerJoin(planFeatures, eq(planFeatures.planFk, accountSubscriptions.planFk))
      .where(
        and(
          eq(accountSubscriptions.accountFk, accountId),
          eq(planFeatures.key, key),
        ),
      );
    return row?.enabled ?? false;
  }

  /** null limit = unlimited; otherwise strict less-than (subscription §3A). */
  canCreate(limit: number | null, current: number): boolean {
    return limit === null || current < limit;
  }
}
