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
import { DRIZZLE } from '#db/db.module.js';
import * as schema from '#db/schema.js';
import { locations, userLocationMappings } from '#db/schema.js';
import {
  IS_PUBLIC_KEY,
  LOCATION_CONTEXT_KEY,
  readScopedSource,
  type StoreContextSource,
} from '../decorators/rbac.decorators.js';
import { RbacRepository } from '../rbac.repository.js';
import '../resolved-store-context.js';

/** HTTP methods that never touch the write-gate (reads are never blocked). */
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

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
 * A downgrade-locked location (`locations.locked`) additionally blocks WRITES
 * only — reads (history/reports) keep working, same contract as a locked
 * store in SubscriptionStatusGuard. Unlike that account-wide pending gate,
 * a location lock is permanent until the owner unlocks it or upgrades, so
 * it's checked here regardless of `reconciliation_status`.
 *
 * Routes without @LocationContext pass through untouched.
 */
@Injectable()
export class LocationGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>,
    private readonly rbacRepo: RbacRepository,
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

    const context = req.context;
    if (!context?.storeId) {
      // @LocationContext without a resolved store — fail safe (misconfig).
      throw new ForbiddenException('STORE_CONTEXT_MISSING');
    }

    const raw = readScopedSource(req, source);
    if (!raw) throw new ForbiddenException('LOCATION_CONTEXT_MISSING');

    // 1. Location must belong to this store and be active.
    const [loc] = await this.db
      .select({ id: locations.id, locked: locations.locked })
      .from(locations)
      .where(and(
        eq(locations.id, raw),
        eq(locations.storeFk, context.storeId),
        eq(locations.isActive, true),
      ));
    if (!loc) throw new NotFoundException('LOCATION_NOT_ACCESSIBLE');

    if (loc.locked && !READ_METHODS.has(req.method)) {
      throw new ForbiddenException('LOCATION_LOCKED');
    }

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

  /**
   * Reuses RbacRepository.findActiveRolesForUser — the one canonical "active
   * role" predicate (revokedAt IS NULL AND (expiresAt IS NULL OR expiresAt >
   * now()) AND roles.deletedAt IS NULL) — instead of a bespoke query, so this
   * can't drift from the definition every other active-role check in the
   * codebase enforces.
   */
  private async isStoreOwner(userId: string, storeId: string): Promise<boolean> {
    const activeRoles = await this.rbacRepo.findActiveRolesForUser(userId, storeId);
    return activeRoles.some(
      (role) => role.code === 'STORE_OWNER' && role.roleStoreFk === storeId,
    );
  }
}
