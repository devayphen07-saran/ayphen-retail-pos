import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { RbacService } from '../rbac.service.js';
import { RbacRepository } from '../rbac.repository.js';
import {
  IS_PUBLIC_KEY,
  STORE_CONTEXT_KEY,
  readScopedSource,
  type StoreContextSource,
} from '../decorators/rbac.decorators.js';
import type { ResolvedStoreContext } from '../resolved-store-context.js';

/**
 * TenantGuard (rbac.md §10B). Runs after MobileJwtGuard. Resolves the store id
 * from @StoreContext(source) metadata, verifies the user can access it (via the
 * Redis-cached accessible-store list), and writes request.context.
 *
 * Non-existent and inaccessible stores both return 404 STORE_NOT_ACCESSIBLE —
 * identical response, timing-oracle safe (§19). Routes without @StoreContext (or
 * with 'none') pass through without resolving a store.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly rbac: RbacService,
    private readonly repo: RbacRepository,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const source = this.reflector.getAllAndOverride<StoreContextSource>(
      STORE_CONTEXT_KEY,
      [ctx.getHandler(), ctx.getClass()],
    );
    // No @StoreContext, or explicitly 'none' → nothing to resolve.
    if (!source || source === 'none') return true;

    const req = ctx.switchToHttp().getRequest<Request>();
    const principal = req.user;
    if (!principal) throw new UnauthorizedException('MISSING_AUTH');

    const raw = readScopedSource(req, source);
    if (!raw) throw new ForbiddenException('STORE_CONTEXT_MISSING');

    const accessibleIds = await this.rbac.userStoreIds(principal.userId);
    const store = await this.repo.resolveAccessibleStore(raw, accessibleIds);

    // Same error for missing + inaccessible (timing-oracle protection, §19).
    if (!store) throw new NotFoundException('STORE_NOT_ACCESSIBLE');

    const context: ResolvedStoreContext = {
      storeId:   store.id,
      accountId: store.accountFk,
      isLocked:  store.locked,
    };
    req.context = context;

    return true;
  }
}
