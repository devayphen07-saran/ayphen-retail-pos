import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { RbacRouteValidatorService } from './rbac-route.validator.service.js';

/**
 * Hosts the startup route-config validator (rbac.md §11). Kept as its own
 * NON-global module imported LAST in AppModule: DiscoveryModule pulls in the
 * discovery infrastructure, and placing it inside the @Global RbacModule (which
 * loads early) perturbs global-provider instantiation order and breaks
 * unrelated providers (e.g. CORE_REDIS resolution). Isolated here, it runs after
 * every other module is wired and only reads route metadata.
 */
@Module({
  imports: [DiscoveryModule],
  providers: [RbacRouteValidatorService],
})
export class RbacRouteValidatorModule {}