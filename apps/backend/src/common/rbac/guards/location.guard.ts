import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { and, eq, isNull } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Request } from 'express';
import { DRIZZLE } from '../../../db/db.module.js';
import * as schema from '../../../db/schema.js';
import {
  locations,
  userLocationMappings,
  userRoleMappings,
  roles,
} from '../../../db/schema.js';
import {
  IS_PUBLIC_KEY,
  LOCATION_CONTEXT_KEY,
  type StoreContextSource,
} from '../decorators/rbac.decorators.js';
import type { ResolvedStoreContext } from '../resolved-store-context.js';

/**
 * LocationGuard (adoption §8.1). Runs AFTER TenantGuard. When @LocationContext is
 * present, resolves the location id, verifies it belongs to the request's store,
 * and applies the DUAL GATE:
 *
 *   role grants WHAT (checked by PermissionsGuard)  AND
 *   location assignment grants WHERE (checked here) — unless the user is
 *   STORE_OWNER, who is implicitly assigned to every location (owner bypass).
 *
 * Non-existent and unassigned locations both surface distinctly:
 *   404 LOCATION_NOT_ACCESSIBLE  — not in this store / archived
 *   403 LOCATION_ACCESS_DENIED   — exists but the user isn't assigned
 *
 * Routes without @LocationContext pass through untouched.
 */
@Injectable()
export class LocationGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const source = this.reflector.getAllAndOverride<StoreContextSource>(
      LOCATION_CONTEXT_KEY,
      [ctx.getHandler(), ctx.getClass()],
    );
    if (!source || source === 'none') return true; // nothing to resolve

    const req = ctx.switchToHttp().getRequest<Request>();
    const principal = req.user;
    if (!principal) throw new UnauthorizedException('MISSING_AUTH');

    const context = (req as Request & { context?: ResolvedStoreContext }).context;
    if (!context?.storeId) {
      // @LocationContext without a resolved store — fail safe (misconfig).
      throw new ForbiddenException('STORE_CONTEXT_MISSING');
    }

    const raw = this.readSource(req, source);
    if (!raw) throw new ForbiddenException('LOCATION_CONTEXT_MISSING');

    // 1. Location must belong to this store and be active.
    const [loc] = await this.db
      .select({ id: locations.id })
      .from(locations)
      .where(and(
        eq(locations.id, raw),
        eq(locations.storeFk, context.storeId),
        eq(locations.isActive, true),
      ));
    if (!loc) throw new NotFoundException('LOCATION_NOT_ACCESSIBLE');

    // 2. Owner bypass — STORE_OWNER is implicitly at every location.
    const owner = await this.isStoreOwner(principal.userId, context.storeId);
    if (!owner) {
      // 3. Dual gate — require an active assignment.
      const [assigned] = await this.db
        .select({ id: userLocationMappings.id })
        .from(userLocationMappings)
        .where(and(
          eq(userLocationMappings.userFk, principal.userId),
          eq(userLocationMappings.locationFk, loc.id),
          isNull(userLocationMappings.revokedAt),
        ));
      if (!assigned) throw new ForbiddenException('LOCATION_ACCESS_DENIED');
    }

    context.locationId = loc.id;
    return true;
  }

  private async isStoreOwner(userId: string, storeId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: userRoleMappings.id })
      .from(userRoleMappings)
      .innerJoin(roles, eq(userRoleMappings.roleFk, roles.id))
      .where(and(
        eq(userRoleMappings.userFk, userId),
        eq(userRoleMappings.storeFk, storeId),
        eq(roles.code, 'STORE_OWNER'),
        isNull(userRoleMappings.revokedAt),
      ));
    return !!row;
  }

  /** Extract the raw location id from the request per 'scope.key'. */
  private readSource(req: Request, source: StoreContextSource): string | undefined {
    const dot = source.indexOf('.');
    if (dot < 0) return undefined;
    const scope = source.slice(0, dot);
    const key = source.slice(dot + 1);

    let value: unknown;
    switch (scope) {
      case 'param':  value = req.params?.[key]; break;
      case 'query':  value = req.query?.[key]; break;
      case 'body':   value = (req.body as Record<string, unknown> | undefined)?.[key]; break;
      case 'header': value = req.headers?.[key.toLowerCase()]; break;
      default:       return undefined;
    }
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }
}
