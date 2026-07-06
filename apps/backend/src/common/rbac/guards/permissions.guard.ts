import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { RbacService } from '../rbac.service.js';
import { AuditService } from '#auth/core/audit.service.js';
import {
  IS_PUBLIC_KEY,
  ONLINE_ONLY_KEY,
  REQUIRE_PERMISSIONS_KEY,
  REQUIRE_SPECIAL_KEY,
  type RequirePermissionsMeta,
  type RequireSpecialMeta,
} from '../decorators/rbac.decorators.js';
import { CRITICAL_SPECIAL_ACTIONS } from '../permission-matrix.constants.js';
import type { ResolvedStoreContext } from '../resolved-store-context.js';

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
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const permission = this.reflector.getAllAndOverride<RequirePermissionsMeta>(
      REQUIRE_PERMISSIONS_KEY,
      [ctx.getHandler(), ctx.getClass()],
    );
    const special = this.reflector.getAllAndOverride<RequireSpecialMeta>(
      REQUIRE_SPECIAL_KEY,
      [ctx.getHandler(), ctx.getClass()],
    );
    // Neither @RequirePermissions nor @RequireSpecial → no RBAC enforcement.
    // A @RequireSpecial without @RequirePermissions still enforces on its own.
    if (!permission && !special) return true;

    const req = ctx.switchToHttp().getRequest<Request>();
    const principal = req.user;
    if (!principal) throw new UnauthorizedException('MISSING_AUTH');

    // @OnlineOnly: reject offline-replay requests (§10C).
    const onlineOnly = this.reflector.getAllAndOverride<boolean>(ONLINE_ONLY_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (onlineOnly && req.headers['x-client-mode'] === 'offline_replay') {
      throw new ForbiddenException('ONLINE_REQUIRED');
    }

    // Store must be resolved by TenantGuard. Missing → fail closed, not 500,
    // to prevent cross-store escalation on a broken guard chain (§19).
    const context = (req as Request & { context?: ResolvedStoreContext }).context;
    if (!context?.storeId) {
      this.logger.error(
        `[SECURITY] PermissionsGuard reached without a resolved store context ` +
          `(user ${principal.userId}, route ${req.method} ${req.url}). Is @StoreContext missing?`,
      );
      throw new ForbiddenException('STORE_CONTEXT_MISSING');
    }
    const storeId = context.storeId;

    // H-6 (§16): JWT pv vs current permissionsVersion mismatch → bust cache first.
    if (principal.jwtPv !== principal.permissionsVersion) {
      await this.rbac.invalidateUserStoreCache(principal.userId, storeId);
    }

    // Critical = delete CRUD, or a critical special action (§7) → 30s TTL.
    const isCritical =
      permission?.action === 'delete' ||
      (special !== undefined && CRITICAL_SPECIAL_ACTIONS.has(special.actionCode));

    const permissions = await this.rbac.getCachedPermissions(
      principal.userId,
      storeId,
      isCritical,
    );

    // CRUD check (only when @RequirePermissions is present).
    if (permission && !this.rbac.checkCrud(permissions, permission.entity, permission.action)) {
      await this.denyAudit(principal.userId, storeId, req, {
        entity: permission.entity,
        action: permission.action,
        code: 'PERMISSION_DENIED',
      });
      throw new ForbiddenException('PERMISSION_DENIED');
    }

    // Special-action check (stacks on top of CRUD).
    if (special) {
      if (!this.rbac.checkSpecial(permissions, special.entity, special.actionCode)) {
        await this.denyAudit(principal.userId, storeId, req, {
          entity: special.entity,
          action: special.actionCode,
          code: 'SPECIAL_PERMISSION_DENIED',
        });
        throw new ForbiddenException('SPECIAL_PERMISSION_DENIED');
      }
    }

    // Expose resolved permissions to downstream handlers.
    context.permissions = permissions;
    return true;
  }

  /** SOC2 CC6.3 denial audit — written before the ForbiddenException (§20). */
  private async denyAudit(
    userId: string,
    storeId: string,
    req: Request,
    meta: { entity: string; action: string; code: string },
  ): Promise<void> {
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
  }
}
