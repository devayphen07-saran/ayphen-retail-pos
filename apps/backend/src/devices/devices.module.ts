import { Module } from '@nestjs/common';
import { AuthCoreModule } from '../auth/core/auth-core.module.js';
import { MobileAuthModule } from '../auth/mobile/mobile-auth.module.js';
import { SubscriptionModule } from '../subscription/subscription.module.js';
import { DeviceAccessRepository } from './device-access.repository.js';
import { DeviceAccessService } from './device-access.service.js';
import {
  StoreDeviceController,
  StoreAccessController,
} from './store-device.controller.js';
import { MyDeviceController } from './my-device.controller.js';

/**
 * Device slot + store-access management (device-management §7–§14). Reuses
 * EntitlementService (max_devices_per_store) from SubscriptionModule and the
 * auth guards from MobileAuthModule / global RbacModule.
 */
@Module({
  imports: [AuthCoreModule, MobileAuthModule, SubscriptionModule],
  controllers: [
    StoreDeviceController,
    StoreAccessController,
    MyDeviceController,
  ],
  providers: [DeviceAccessRepository, DeviceAccessService],
})
export class DevicesModule {}
