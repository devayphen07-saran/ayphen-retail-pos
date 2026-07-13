import { Global, Logger, Module } from '@nestjs/common';
import { AppConfigService } from '#config/app-config.service.js';
import { STORAGE_PROVIDER, type StorageProvider } from './storage.provider.js';
import { LocalStorageProvider } from './local-storage.provider.js';
import { S3StorageProvider } from './s3-storage.provider.js';

/**
 * Binds the object-store provider at wire time: a real S3-compatible store when
 * `STORAGE_BUCKET` is configured, otherwise the on-disk LocalStorageProvider
 * (dev only) — the same "absent → fake provider" pattern the payments module
 * uses for Razorpay. Both providers are instantiated (the raw-serve controller
 * injects LocalStorageProvider directly), so the "which store is active" log
 * lives HERE, in the selection factory, not in either constructor — otherwise
 * the unused provider would log a misleading line on every boot.
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
      ): StorageProvider => {
        const logger = new Logger('StorageModule');
        if (config.storageConfigured) {
          logger.log(
            `Object storage: S3-compatible bucket "${config.storageBucket}" (region ${config.storageRegion}` +
              (config.storageEndpoint ? `, endpoint ${config.storageEndpoint}` : '') +
              ').',
          );
          return s3;
        }
        logger.warn(
          `Object storage not configured — using on-disk LocalStorageProvider at ${config.storageLocalDir} (dev only).`,
        );
        return local;
      },
    },
  ],
  exports: [STORAGE_PROVIDER, LocalStorageProvider],
})
export class StorageModule {}
