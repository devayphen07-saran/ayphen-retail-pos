import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ForbiddenError, UnauthorizedError } from '#common/exceptions/app.exception.js';
import { ErrorCodes } from '#common/error-codes.js';
import { RbacService } from '../rbac.service.js';
import { AuditService } from '#common/audit/audit.service.js';
import type { MobilePrincipal } from '#common/types/principal.js';
import type { EffectivePermissions } from '../effective-permissions.js';
import {
  IS_PUBLIC_KEY,
  ONLINE_ONLY_KEY,
  REQUIRE_PERMISSIONS_KEY,
  REQUIRE_SPECIAL_KEY,
  type RequirePermissionsMeta,
  type RequireSpecialMeta,
} from '../decorators/rbac.decorators.js';
import { CRITICAL_SPECIAL_ACTIONS } from '../permission-matrix.constants.js';
import '../resolved-store-context.js';

interface RouteRbacMeta {
  isPublic: boolean;
  permission?: RequirePermissionsMeta;
  special?: RequireSpecialMeta;
  onlineOnly?: boolean;
}

/**
 * PermissionsGuard (rbac.md §10C) — the core RBAC gate. Runs after TenantGuard.
 *
 * Reads @RequirePermissions / @RequireSpecial; resolves the store from
 * request.context; busts the cache on a permissions-version mismatch (H-6, §16);
 * enforces CRUD + special checks against RbacService; writes a SOC2 denial audit
 * before throwing 403 (§20, BR-RBAC-007). Routes with no @RequirePermissions
 * pass through untouched.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  private readonly logger = new Logger(PermissionsGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly rbac: RbacService,
    private readonly audit: AuditService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const meta = this.resolveMetadata(ctx);
    if (meta.isPublic) return true;
    // Neither @RequirePermissions nor @RequireSpecial → no RBAC enforcement.
    // A @RequireSpecial without @RequirePermissions still enforces on its own.
    if (!meta.permission && !meta.special) return true;

    const req = ctx.switchToHttp().getRequest<Request>();
    const principal = req.user;
    if (!principal) throw new UnauthorizedError(ErrorCodes.MISSING_AUTH);

    // @OnlineOnly: reject offline-replay requests (§10C).
    if (meta.onlineOnly && req.headers['x-client-mode'] === 'offline_replay') {
      throw new ForbiddenError(ErrorCodes.ONLINE_REQUIRED, 'This action requires being online');
    }

    // Store must be resolved by TenantGuard. Missing → fail closed, not 500,
    // to prevent cross-store escalation on a broken guard chain (§19).
    const context = req.context;
    if (!context?.storeId) {
      this.logger.error(
        `[SECURITY] PermissionsGuard reached without a resolved store context ` +
          `(user ${principal.userId}, route ${req.method} ${req.url}). Is @StoreContext missing?`,
      );
      throw new ForbiddenError(ErrorCodes.STORE_CONTEXT_MISSING, 'A store context is required');
    }
    const storeId = context.storeId;

    await this.bustCacheOnVersionMismatch(principal, storeId);

    const isCritical = this.computeCriticality(meta.permission, meta.special);
    const permissions = await this.rbac.getCachedPermissions(
      principal.userId,
      storeId,
      isCritical,
    );

    await this.enforceCrud(permissions, meta.permission, principal.userId, storeId, req);
    await this.enforceSpecial(permissions, meta.special, principal.userId, storeId, req);

    // Expose resolved permissions to downstream handlers.
    context.permissions = permissions;
    return true;
  }

  private resolveMetadata(ctx: ExecutionContext): RouteRbacMeta {
    const target = [ctx.getHandler(), ctx.getClass()];
    return {
      isPublic: this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, target) ?? false,
      permission: this.reflector.getAllAndOverride<RequirePermissionsMeta>(
        REQUIRE_PERMISSIONS_KEY,
        target,
      ),
      special: this.reflector.getAllAndOverride<RequireSpecialMeta>(REQUIRE_SPECIAL_KEY, target),
      onlineOnly: this.reflector.getAllAndOverride<boolean>(ONLINE_ONLY_KEY, target),
    };
  }

  /**
   * H-6 (§16): JWT pv vs current permissionsVersion mismatch → bust cache
   * first. Best-effort: a Redis outage here must not 500 the request — worst
   * case, getCachedPermissions below serves an entry within its documented
   * staleness window instead of a fully-busted cache (mirrors the degrade
   * policy in RbacService.getCachedPermissions).
   */
  private async bustCacheOnVersionMismatch(
    principal: MobilePrincipal,
    storeId: string,
  ): Promise<void> {
    if (principal.jwtPv === principal.permissionsVersion) return;
    try {
      await this.rbac.invalidateUserStoreCache(principal.userId, storeId);
    } catch (err) {
      this.logger.warn(
        `Cache bust failed for user ${principal.userId} store ${storeId}: ${
          err instanceof Error ? err.message : 'unknown Redis error'
        }`,
      );
    }
  }

  /** Critical = delete CRUD, or a critical special action (§7) → 30s TTL. */
  private computeCriticality(
    permission: RequirePermissionsMeta | undefined,
    special: RequireSpecialMeta | undefined,
  ): boolean {
    return (
      permission?.action === 'delete' ||
      (special !== undefined && CRITICAL_SPECIAL_ACTIONS.has(special.actionCode))
    );
  }

  /** CRUD check (only when @RequirePermissions is present). */
  private async enforceCrud(
    permissions: EffectivePermissions,
    permission: RequirePermissionsMeta | undefined,
    userId: string,
    storeId: string,
    req: Request,
  ): Promise<void> {
    if (!permission) return;
    if (this.rbac.checkCrud(permissions, permission.entity, permission.action)) return;
    await this.denyAudit(userId, storeId, req, {
      entity: permission.entity,
      action: permission.action,
      code: 'PERMISSION_DENIED',
    });
    throw new ForbiddenError(ErrorCodes.PERMISSION_DENIED, 'You do not have permission to perform this action');
  }

  /** Special-action check (stacks on top of CRUD). */
  private async enforceSpecial(
    permissions: EffectivePermissions,
    special: RequireSpecialMeta | undefined,
    userId: string,
    storeId: string,
    req: Request,
  ): Promise<void> {
    if (!special) return;
    if (this.rbac.checkSpecial(permissions, special.entity, special.actionCode)) return;
    await this.denyAudit(userId, storeId, req, {
      entity: special.entity,
      action: special.actionCode,
      code: 'SPECIAL_PERMISSION_DENIED',
    });
    throw new ForbiddenError(ErrorCodes.SPECIAL_PERMISSION_DENIED, 'You do not have permission to perform this action');
  }

  /** SOC2 CC6.3 denial audit — written before the ForbiddenError (§20). */
  private async denyAudit(
    userId: string,
    storeId: string,
    req: Request,
    meta: { entity: string; action: string; code: string },
  ): Promise<void> {
    // Best-effort: the denial itself is the security outcome. If the audit
    // insert fails, it must NOT convert the 403 into a 500 (the caller throws
    // ForbiddenException right after) or swallow the denial — log and move on.
    try {
      await this.audit.log({
        event:        meta.code,
        activityType: meta.code === 'SPECIAL_PERMISSION_DENIED'
          ? 'SPECIAL_PERMISSION_DENIED'
          : 'PERMISSION_DENIED',
        prefix:       'Access',
        suffix:       `denied on ${meta.entity}.${meta.action}`,
        userId,
        storeFk:      storeId,
        isSuccess:    false,
        entityType:   meta.entity,
        metadata:     { action: meta.action, route: `${req.method} ${req.url}` },
      });
    } catch (err) {
      this.logger.error(
        `Failed to write denial audit for ${meta.code} on ${meta.entity}.${meta.action} (user ${userId}): ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
      );
    }
  }
}
