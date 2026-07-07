import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import type { InstanceWrapper } from '@nestjs/core/injector/instance-wrapper.js';
import { MobileJwtGuard } from '#auth/mobile/guards/mobile-jwt.guard.js';
import {
  IS_PUBLIC_KEY,
  REQUIRE_PERMISSIONS_KEY,
  STORE_CONTEXT_KEY,
  STEP_UP_AUTH_KEY,
  LOCATION_CONTEXT_KEY,
} from './decorators/rbac.decorators.js';
import { TenantGuard } from './guards/tenant.guard.js';
import { PermissionsGuard } from './guards/permissions.guard.js';
import { LocationGuard } from './guards/location.guard.js';

// @nestjs/common internal metadata keys (stable across v6–v11).
const PATH_METADATA = 'path';
const GUARDS_METADATA = '__guards__';

/**
 * Startup route validator (rbac.md §11, BR-RBAC-001). After controllers are
 * registered, before the server listens, throws if a route has
 * @RequirePermissions (or @StepUpAuth) without @StoreContext — which would leave
 * it store-unscoped and fall through with no tenant boundary.
 */
@Injectable()
export class RouteCoverageValidator implements OnApplicationBootstrap {
  private readonly logger = new Logger(RouteCoverageValidator.name);

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    private readonly reflector: Reflector,
  ) {}

  onApplicationBootstrap(): void {
    const controllers = this.discovery.getControllers();
    const errors: string[] = [];

    for (const wrapper of controllers) {
      if (!wrapper.instance || !wrapper.metatype) continue;
      this.checkController(wrapper, errors);
    }

    if (errors.length) {
      throw new Error(
        `[RBAC] Route configuration invalid:\n  - ${errors.join('\n  - ')}`,
      );
    }
    this.logger.log('RBAC route configuration validated.');
  }

  private checkController(wrapper: InstanceWrapper, errors: string[]): void {
    const { instance, metatype } = wrapper;
    const proto = Object.getPrototypeOf(instance);
    const className = metatype!.name;

    const classHasStoreContext =
      this.reflector.get(STORE_CONTEXT_KEY, metatype!) !== undefined;
    const classHasLocationContext =
      this.reflector.get(LOCATION_CONTEXT_KEY, metatype!) !== undefined;

    const methods = this.scanner.getAllMethodNames(proto);
    for (const methodName of methods) {
      const handler = proto[methodName];
      if (typeof handler !== 'function') continue;

      // Real execution order: class-level @UseGuards run before method-level
      // ones. Preserved (not just collected into a Set) so guard ORDER, not
      // just presence, can be validated below — TenantGuard must resolve
      // request.context before PermissionsGuard/LocationGuard read it.
      const guardOrder: string[] = [
        ...(Reflect.getMetadata(GUARDS_METADATA, metatype!) ?? []),
        ...(Reflect.getMetadata(GUARDS_METADATA, handler) ?? []),
      ]
        .filter((g): g is Function => typeof g === 'function')
        .map((g) => g.name);
      const guardNames = new Set(guardOrder);

      // Auth coverage: every HTTP route must be @Public or carry MobileJwtGuard.
      // A forgotten guard would otherwise ship a fully unauthenticated endpoint;
      // caught here at boot, not in production.
      const isRoute = Reflect.getMetadata(PATH_METADATA, handler) !== undefined;
      if (isRoute) {
        const isPublic =
          this.reflector.get(IS_PUBLIC_KEY, metatype!) === true ||
          this.reflector.get(IS_PUBLIC_KEY, handler) === true;
        if (!isPublic && !guardNames.has(MobileJwtGuard.name)) {
          errors.push(
            `${className}.${methodName} is neither @Public nor guarded by MobileJwtGuard.`,
          );
        }
      }

      const requiresPerm = this.reflector.get(REQUIRE_PERMISSIONS_KEY, handler);
      const requiresStepUp = this.reflector.get(STEP_UP_AUTH_KEY, handler);
      const hasLocationContext =
        classHasLocationContext ||
        this.reflector.get(LOCATION_CONTEXT_KEY, handler) !== undefined;
      const hasStoreContext =
        classHasStoreContext ||
        this.reflector.get(STORE_CONTEXT_KEY, handler) !== undefined;
      const storeContextSource =
        this.reflector.get(STORE_CONTEXT_KEY, handler) ??
        this.reflector.get(STORE_CONTEXT_KEY, metatype!);

      // Declaring the decorator without its enforcing guard actually applied
      // via @UseGuards would ship an endpoint with the *intent* to check
      // permissions/tenancy/location but nothing enforcing it at runtime —
      // silently unauthorized-by-anyone. Checked independently of whatever
      // else is declared on this route, not just in combination.
      if (requiresPerm !== undefined && !guardNames.has(PermissionsGuard.name)) {
        errors.push(
          `${className}.${methodName} has @RequirePermissions but PermissionsGuard is not in @UseGuards(...).`,
        );
      }
      if (hasLocationContext && !guardNames.has(LocationGuard.name)) {
        errors.push(
          `${className}.${methodName} has @LocationContext but LocationGuard is not in @UseGuards(...).`,
        );
      }
      // 'none' is the explicit opt-out (rbac.md) — only a real source implies
      // TenantGuard must be the one resolving it. Runs regardless of whether
      // @RequirePermissions is also present, since controllers can rely on
      // TenantGuard alone (e.g. sync's class-level @StoreContext with no
      // per-method permission decorator).
      if (hasStoreContext && storeContextSource !== 'none' && !guardNames.has(TenantGuard.name)) {
        errors.push(
          `${className}.${methodName} has @StoreContext but TenantGuard is not in @UseGuards(...).`,
        );
      }

      this.checkGuardOrder(className, methodName, guardOrder, errors);

      // Only routes that opt into RBAC / step-up / location scoping need a store.
      if (requiresPerm === undefined && requiresStepUp === undefined && !hasLocationContext) {
        continue;
      }

      if (!hasStoreContext) {
        const which =
          requiresPerm !== undefined ? '@RequirePermissions'
          : requiresStepUp !== undefined ? '@StepUpAuth'
          : '@LocationContext';
        errors.push(
          `${className}.${methodName} has ${which} but no @StoreContext — ` +
            `it would run store-unscoped. Add @StoreContext(...) or @StoreContext('none').`,
        );
      }
    }
  }

  /**
   * PermissionsGuard/LocationGuard both read `request.context`, which only
   * TenantGuard writes — presence-only checking (above) can't catch
   * `@UseGuards(PermissionsGuard, TenantGuard, ...)` (wrong order): that
   * passes the presence check and only fails at request time, as a
   * permanent, confusing 403 on that route. Order is irrelevant when
   * TenantGuard is absent entirely — that's already a separate finding
   * from the presence checks above.
   */
  private checkGuardOrder(
    className: string,
    methodName: string,
    guardOrder: string[],
    errors: string[],
  ): void {
    const tenantIdx = guardOrder.indexOf(TenantGuard.name);
    if (tenantIdx === -1) return;

    for (const dependent of [PermissionsGuard.name, LocationGuard.name]) {
      const dependentIdx = guardOrder.indexOf(dependent);
      if (dependentIdx !== -1 && dependentIdx < tenantIdx) {
        errors.push(
          `${className}.${methodName} has ${dependent} before TenantGuard in @UseGuards(...) — ` +
            `${dependent} reads request.context, which TenantGuard hasn't resolved yet at that point.`,
        );
      }
    }
  }
}
