import { Injectable, NotFoundException } from '@nestjs/common';
import { EntityTypesRepository, type EntityTypeRow } from './entity-types.repository.js';

@Injectable()
export class EntityTypesService {
  constructor(private readonly repo: EntityTypesRepository) {}

  listAll(): Promise<EntityTypeRow[]> {
    return this.repo.listAll();
  }

  async findByCode(code: string): Promise<EntityTypeRow> {
    const row = await this.repo.findByCode(code);
    if (!row) throw new NotFoundException('ENTITY_TYPE_NOT_FOUND');
    return row;
  }

  listOfflineSafe(): Promise<EntityTypeRow[]> {
    return this.repo.listOfflineSafe();
  }

  supportsAttachments(code: string): Promise<boolean> {
    return this.repo.supportsAttachments(code);
  }
}
