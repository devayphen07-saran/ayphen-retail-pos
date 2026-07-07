import { Global, Module } from '@nestjs/common';
import { StoreRepository } from '../stores/store/store.repository.js';
import { LocationRepository } from '../locations/location.repository.js';
import { DeviceAccessRepository } from '../devices/device-access.repository.js';
import { InvitationRepository } from '../stores/invitation/invitation.repository.js';

/**
 * StoreRepository / LocationRepository / DeviceAccessRepository /
 * InvitationRepository are each owned by one feature module (StoresModule,
 * LocationsModule, DevicesModule) but consumed across several others
 * (SubscriptionModule, SyncModule, and each other) — and that consumer graph
 * is circular (LocationsModule imports SubscriptionModule and SyncModule;
 * DevicesModule imports SubscriptionModule; StoresModule imports
 * LocationsModule), so no consumer can `imports: [XModule]` its way to the
 * owning module's export without closing a cycle. Every consumer was instead
 * re-declaring its own local copy of these repositories — same class,
 * independently DI-instantiated per module, purely to route around the cycle.
 *
 * This module owns none of the feature modules above and imports nothing
 * from them, so importing it can never itself create a cycle. `@Global()`
 * means every module gets these four repositories from one shared instance
 * with nothing to add to its own `imports` array.
 */
@Global()
@Module({
  providers: [
    StoreRepository,
    LocationRepository,
    DeviceAccessRepository,
    InvitationRepository,
  ],
  exports: [
    StoreRepository,
    LocationRepository,
    DeviceAccessRepository,
    InvitationRepository,
  ],
})
export class SharedRepositoriesModule {}
