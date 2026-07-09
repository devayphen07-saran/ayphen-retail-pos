import { Global, Module } from '@nestjs/common';
import { StoreRepository } from '../stores/store/store.repository.js';
import { DeviceAccessRepository } from '../devices/device-access.repository.js';
import { InvitationRepository } from '../stores/invitation/invitation.repository.js';

/**
 * StoreRepository / DeviceAccessRepository / InvitationRepository are each
 * owned by one feature module (StoresModule, DevicesModule) but consumed
 * across several others (SubscriptionModule, SyncModule, and each other).
 * Rather than have every consumer `imports: [XModule]` its way to the owning
 * module's export (and risk reintroducing a cycle as these modules evolve),
 * they're re-declared here once and shared globally.
 *
 * This module owns none of the feature modules above and imports nothing
 * from them, so importing it can never itself create a cycle. `@Global()`
 * means every module gets these repositories from one shared instance with
 * nothing to add to its own `imports` array.
 */
@Global()
@Module({
  providers: [
    StoreRepository,
    DeviceAccessRepository,
    InvitationRepository,
  ],
  exports: [
    StoreRepository,
    DeviceAccessRepository,
    InvitationRepository,
  ],
})
export class SharedRepositoriesModule {}
