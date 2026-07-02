import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import type { InstanceWrapper } from '@nestjs/core/injector/instance-wrapper.js';
import {
  REQUIRE_PERMISSIONS_KEY,
  STORE_CONTEXT_KEY,
  STEP_UP_AUTH_KEY,
  LOCATION_CONTEXT_KEY,
} from './decorators/rbac.decorators.js';

/**
 * Startup route validator (rbac.md §11, BR-RBAC-001). After controllers are
 * registered, before the server listens, throws if a route has
 * @RequirePermissions (or @StepUpAuth) without @StoreContext — which would leave
 * it store-unscoped and fall through with no tenant boundary.
 */
@Injectable()
export class RbacRouteValidatorService implements OnApplicationBootstrap {
  private readonly logger = new Logger(RbacRouteValidatorService.name);

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

      const requiresPerm = this.reflector.get(REQUIRE_PERMISSIONS_KEY, handler);
      const requiresStepUp = this.reflector.get(STEP_UP_AUTH_KEY, handler);
      const hasLocationContext =
        classHasLocationContext ||
        this.reflector.get(LOCATION_CONTEXT_KEY, handler) !== undefined;

      // Only routes that opt into RBAC / step-up / location scoping need a store.
      if (requiresPerm === undefined && requiresStepUp === undefined && !hasLocationContext) {
        continue;
      }

      const hasStoreContext =
        classHasStoreContext ||
        this.reflector.get(STORE_CONTEXT_KEY, handler) !== undefined;

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
}
