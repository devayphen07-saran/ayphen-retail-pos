import { Module } from '@nestjs/common';
import { MobileAuthModule } from '#auth/mobile/mobile-auth.module.js';
import { SubscriptionStatusGuard } from '#auth/mobile/guards/subscription-status.guard.js';
import { SyncController } from './sync.controller.js';
import { TimeController } from './time.controller.js';
import { SyncCursorService } from './cursor/sync-cursor.service.js';
import { SyncFilterRegistry } from './registry/sync-filter.registry.js';
import { TombstoneRepository } from './repositories/tombstone.repository.js';
import { SyncInitProgressRepository } from './repositories/sync-init-progress.repository.js';
import { SyncIdempotencyRepository } from './repositories/sync-idempotency.repository.js';
import { SyncMutationFailureRepository } from './repositories/sync-mutation-failure.repository.js';
import { SyncConflictRepository } from './repositories/sync-conflict.repository.js';
import { DeviceSyncHealthRepository } from './repositories/device-sync-health.repository.js';
import { SyncChangesService } from './pull/changes.service.js';
import { InitialSyncService } from './pull/initial-sync.service.js';
import { SyncDeltaService } from './push/delta.service.js';
import { SyncConflictService } from './services/sync-conflict.service.js';
import { MutationHandlerRegistry } from './push/mutation-handler.registry.js';
import type { SyncMutationHandler } from './push/mutation.types.js';
import { LookupMutationHandler } from './push/handlers/lookup.handler.js';
import { ProductMutationHandler, ProductCaseMutationHandler } from './push/handlers/product.handler.js';
import { CustomerMutationHandler } from './push/handlers/customer.handler.js';
import { SupplierMutationHandler } from './push/handlers/supplier.handler.js';
import { PaymentAccountMutationHandler } from './push/handlers/payment-account.handler.js';

/**
 * The offline-first sync engine (docs/prd/sync-engine.md). Pull: /sync/initial
 * + /sync/changes over the SyncFilterRegistry. Push: /sync/delta through the
 * MutationHandlerRegistry — adding the WS-5 POS handlers (composite order,
 * shift, cash) is registration here, not surgery on the pipeline.
 */
@Module({
  imports: [MobileAuthModule],
  controllers: [SyncController, TimeController],
  providers: [
    SubscriptionStatusGuard,
    SyncCursorService,
    SyncFilterRegistry,
    TombstoneRepository,
    SyncInitProgressRepository,
    SyncIdempotencyRepository,
    SyncMutationFailureRepository,
    SyncConflictRepository,
    DeviceSyncHealthRepository,
    SyncChangesService,
    InitialSyncService,
    SyncDeltaService,
    SyncConflictService,
    LookupMutationHandler,
    ProductMutationHandler,
    ProductCaseMutationHandler,
    CustomerMutationHandler,
    SupplierMutationHandler,
    PaymentAccountMutationHandler,
    {
      provide: MutationHandlerRegistry,
      useFactory: (...handlers: SyncMutationHandler[]) => new MutationHandlerRegistry(handlers),
      inject: [
        LookupMutationHandler,
        ProductMutationHandler,
        ProductCaseMutationHandler,
        CustomerMutationHandler,
        SupplierMutationHandler,
        PaymentAccountMutationHandler,
      ],
    },
  ],
  exports: [TombstoneRepository],
})
export class SyncModule {}