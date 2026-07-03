import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { eq, and, isNull } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Request } from 'express';
import { DRIZZLE } from '#db/db.module.js';
import * as schema from '#db/schema.js';
import { stores, accountUsers } from '#db/schema.js';
import type { MobilePrincipal } from '../types/mobile-principal.js';

/**
 * Tenant isolation guard. Must be applied AFTER MobileJwtGuard on any route
 * that operates on a specific store (i.e. routes with :storeId param).
 *
 * Validates:
 *  1. Store exists and is not soft-deleted
 *  2. Authenticated user belongs to the store's account (via account_users)
 *  3. Attaches request.storeContext = { storeId, accountId, isLocked }
 *
 * RequestContextInterceptor picks up storeId/accountId from storeContext
 * so downstream services can read them via RequestContextService.
 */
@Injectable()
export class StoreGuard implements CanActivate {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req       = context.switchToHttp().getRequest<Request>();
    const principal = req.user as MobilePrincipal | undefined;

    if (!principal) throw new ForbiddenException('UNAUTHENTICATED');

    const storeId = req.params['storeId'];
    if (!storeId) throw new ForbiddenException('MISSING_STORE_ID');

    // Load store — fail fast if not found or soft-deleted
    const [store] = await this.db
      .select()
      .from(stores)
      .where(and(eq(stores.id, storeId), isNull(stores.deletedAt)));

    if (!store) throw new NotFoundException('STORE_NOT_FOUND');

    // Verify the authenticated user belongs to this store's account.
    // Once Phase 4.1 migrations run and stores.accountFk exists, this join
    // is the primary authorization check.
    const [membership] = await this.db
      .select()
      .from(accountUsers)
      .where(
        and(
          eq(accountUsers.accountFk, store.accountFk),
          eq(accountUsers.userFk, principal.userId),
        ),
      );

    if (!membership) throw new ForbiddenException('STORE_ACCESS_DENIED');

    req.storeContext = {
      storeId:   store.id,
      accountId: store.accountFk,
      isLocked:  store.locked ?? false,
    };

    return true;
  }
}
