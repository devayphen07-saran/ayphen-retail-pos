import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { CrudAction, EntityCode } from '../permission-matrix.constants.js';
import type { MobilePrincipal } from '#auth/mobile/types/mobile-principal.js';
import type { ResolvedStoreContext } from '../resolved-store-context.js';

// ─── Metadata keys ──────────────────────────────────────────────────────────

export const IS_PUBLIC_KEY          = 'rbac:isPublic';
export const STORE_CONTEXT_KEY      = 'rbac:storeContext';
export const LOCATION_CONTEXT_KEY   = 'rbac:locationContext';
export const REQUIRE_PERMISSIONS_KEY = 'rbac:requirePermissions';
export const REQUIRE_SPECIAL_KEY    = 'rbac:requireSpecial';
export const ONLINE_ONLY_KEY        = 'rbac:onlineOnly';
export const STEP_UP_AUTH_KEY       = 'rbac:stepUpAuth';

// ─── Payload shapes ─────────────────────────────────────────────────────────

/** Where TenantGuard reads the store id from: 'scope.key', or 'none'. */
export type StoreContextSource =
  | `param.${string}`
  | `query.${string}`
  | `body.${string}`
  | `header.${string}`
  | 'none';

export interface RequirePermissionsMeta {
  entity: EntityCode;
  action: CrudAction;
}

export interface RequireSpecialMeta {
  entity:     EntityCode;
  actionCode: string;
}

export interface StepUpAuthMeta {
  within: string; // e.g. '5m'
}

// ─── Decorators ─────────────────────────────────────────────────────────────

/** Skip all RBAC guards for this route/class (rbac.md §11). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/** Tell TenantGuard where to read the store id from (rbac.md §11). */
export const StoreContext = (source: StoreContextSource) =>
  SetMetadata(STORE_CONTEXT_KEY, source);

/** Tell LocationGuard where to read the location id from (adoption §8.1). */
export const LocationContext = (source: StoreContextSource) =>
  SetMetadata(LOCATION_CONTEXT_KEY, source);

/** PermissionsGuard enforces a CRUD check (rbac.md §10C, §11). */
export const RequirePermissions = (meta: RequirePermissionsMeta) =>
  SetMetadata(REQUIRE_PERMISSIONS_KEY, meta);

/** PermissionsGuard enforces a special-action check; stacks with @RequirePermissions. */
export const RequireSpecial = (meta: RequireSpecialMeta) =>
  SetMetadata(REQUIRE_SPECIAL_KEY, meta);

/** Reject offline-replay requests (X-Client-Mode: offline_replay) (rbac.md §10C). */
export const OnlineOnly = () => SetMetadata(ONLINE_ONLY_KEY, true);

/** Require recent step-up (MFA) within a window (rbac.md §10D). */
export const StepUpAuth = (meta: StepUpAuthMeta) =>
  SetMetadata(STEP_UP_AUTH_KEY, meta);

// ─── Param decorators ───────────────────────────────────────────────────────

/** Inject the authenticated principal (request.user). */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): MobilePrincipal | undefined => {
    return ctx.switchToHttp().getRequest<Request>().user;
  },
);

/** Inject the full auth principal (alias of CurrentUser; parity with rbac.md §11). */
export const CurrentAuth = CurrentUser;

/** Inject the resolved numeric-safe store id from request.context (TenantGuard). */
export const CurrentStoreId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string | undefined => {
    const req = ctx.switchToHttp().getRequest<Request>();
    return (req as Request & { context?: ResolvedStoreContext }).context?.storeId;
  },
);
