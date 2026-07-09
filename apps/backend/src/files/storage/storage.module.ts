import { Global, Module } from '@nestjs/common';
import { AppConfigService } from '#config/app-config.service.js';
import { STORAGE_PROVIDER, type StorageProvider } from './storage.provider.js';
import { LocalStorageProvider } from './local-storage.provider.js';
import { S3StorageProvider } from './s3-storage.provider.js';

/**
 * Binds the object-store provider at wire time: a real S3-compatible store when
 * `STORAGE_BUCKET` is configured, otherwise the on-disk LocalStorageProvider
 * (dev only) — the same "absent → fake provider" pattern the payments module
 * uses for Razorpay. LocalStorageProvider is always instantiated too, so the
 * controller's local raw-serve route can reach it for signed reads.
 */
@Global()
@Module({
  providers: [
    LocalStorageProvider,
    S3StorageProvider,
    {
      provide: STORAGE_PROVIDER,
      inject: [AppConfigService, S3StorageProvider, LocalStorageProvider],
      useFactory: (
        config: AppConfigService,
        s3: S3StorageProvider,
        local: LocalStorageProvider,
      ): StorageProvider => (config.storageConfigured ? s3 : local),
    },
  ],
  exports: [STORAGE_PROVIDER, LocalStorageProvider],
})
export class StorageModule {}
