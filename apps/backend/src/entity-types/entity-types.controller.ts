import { Controller, Get, UseGuards } from '@nestjs/common';
import { MobileJwtGuard } from '#auth/mobile/guards/mobile-jwt.guard.js';
import { StoreContext } from '#common/rbac/decorators/rbac.decorators.js';
import { EntityTypesService } from './entity-types.service.js';
import { EntityTypeMapper, type EntityTypeResponse } from './entity-types.mapper.js';

/**
 * Read-only registry listing (lookup-entity-prd.md §7) — account-level, not
 * store-scoped. Mostly consumed by the sync layer + polymorphic services
 * resolving an entity code to its id; not RBAC-gated (reference data, same
 * as an authenticated user reading their own permission snapshot).
 */
@Controller('entity-types')
@UseGuards(MobileJwtGuard)
@StoreContext('none')
export class EntityTypesController {
  constructor(private readonly entityTypes: EntityTypesService) {}

  @Get()
  async list(): Promise<EntityTypeResponse[]> {
    const rows = await this.entityTypes.listAll();
    return EntityTypeMapper.toList(rows);
  }
}
