import { Module } from '@nestjs/common';
import { EntityTypesController } from './entity-types.controller.js';
import { EntityTypesService } from './entity-types.service.js';
import { EntityTypesRepository } from './entity-types.repository.js';
import { MobileAuthModule } from '#auth/mobile/mobile-auth.module.js';

/**
 * Wires the `entity_types` polymorphic anchor registry (lookup-entity-prd.md
 * §3.3/§6, P0). Consumed by future polymorphic services (FilesService,
 * NotesService, …) to resolve entity_type_fk by code and check
 * supports_attachments before allowing a `files` insert (BR-7).
 */
@Module({
  imports: [MobileAuthModule],
  controllers: [EntityTypesController],
  providers: [EntityTypesService, EntityTypesRepository],
  exports: [EntityTypesService, EntityTypesRepository],
})
export class EntityTypesModule {}
