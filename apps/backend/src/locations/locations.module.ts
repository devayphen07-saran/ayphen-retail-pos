import { Module } from '@nestjs/common';
import { AuthCoreModule } from '../auth/core/auth-core.module.js';
import { MobileAuthModule } from '../auth/mobile/mobile-auth.module.js';
import { SubscriptionModule } from '../subscription/subscription.module.js';
import { LocationRepository } from './location.repository.js';
import { LocationService } from './location.service.js';
import { UserLocationRepository } from './user-location.repository.js';
import { UserLocationService } from './user-location.service.js';
import { LocationController } from './location.controller.js';

/**
 * Store location management (adoption §8.1/§8.2). Reuses EntitlementService
 * (max_locations_per_store, multi_store feature) from SubscriptionModule and the
 * auth/RBAC guards from MobileAuthModule / global RbacModule.
 */
@Module({
  imports: [AuthCoreModule, MobileAuthModule, SubscriptionModule],
  controllers: [LocationController],
  providers: [
    LocationRepository,
    LocationService,
    UserLocationRepository,
    UserLocationService,
  ],
  exports: [LocationRepository, UserLocationRepository],
})
export class LocationsModule {}
