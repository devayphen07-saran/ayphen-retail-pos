import { Module } from '@nestjs/common';
import { StorageModule } from './storage/storage.module.js';
import { EntityTypesModule } from '../entity-types/entity-types.module.js';
import { MobileAuthModule } from '#auth/mobile/mobile-auth.module.js';
import { FilesController } from './files.controller.js';
import { FilesRawController } from './files-raw.controller.js';
import { FilesService } from './files.service.js';
import { FilesRawService } from './files-raw.service.js';
import { FilesRepository } from './files.repository.js';
import { FilesConfigRepository } from './files-config.repository.js';
import { FileValidationService } from './file-validation.service.js';
import { RecordExistenceService } from './record-existence.service.js';
import { TempFileSweeperService } from './temp-file-sweeper.service.js';
import { OrphanFilesReaperService } from './orphan-files-reaper.service.js';

/**
 * Two-phase file/image upload (table-architecture §33). Depends on:
 *  - StorageModule — binds the object-store provider (S3 or on-disk dev).
 *  - EntityTypesModule — resolves entity_type_fk + supports_attachments (BR-7).
 *  - MobileAuthModule — MobileJwtGuard / SubscriptionStatusGuard used on the
 *    store-scoped controller (TenantGuard comes from the global RbacModule).
 */
@Module({
  imports: [StorageModule, EntityTypesModule, MobileAuthModule],
  controllers: [FilesController, FilesRawController],
  providers: [
    FilesService,
    FilesRawService,
    FilesRepository,
    FilesConfigRepository,
    FileValidationService,
    RecordExistenceService,
    TempFileSweeperService,
    OrphanFilesReaperService,
  ],
  exports: [FilesService],
})
export class FilesModule {}
