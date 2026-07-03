import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { LookupRepository, type LookupValueRow } from './lookup.repository.js';
import { LookupTypeRepository, type LookupTypeRow } from './lookup-type.repository.js';
import type {
  CreateLookupValueDto,
  UpdateLookupValueDto,
  CreateLookupTypeDto,
} from './dto/lookup.dto.js';

/**
 * Lookup engine orchestration (lookup-entity-prd.md §6/§9). Enforces the
 * business rules the composite-FK constraint doesn't cover: is_system
 * protection (BR-1), store ownership of custom values (BR-2), per-type
 * uniqueness (BR-4), and soft-delete (BR-6).
 */
@Injectable()
export class LookupService {
  constructor(
    private readonly lookups: LookupRepository,
    private readonly types: LookupTypeRepository,
  ) {}

  // ── Types ─────────────────────────────────────────────────────────────────

  listTypes(): Promise<LookupTypeRow[]> {
    return this.types.listAll();
  }

  async createType(dto: CreateLookupTypeDto): Promise<LookupTypeRow> {
    const existing = await this.types.findByCode(dto.code);
    if (existing) throw new ConflictException('LOOKUP_CODE_EXISTS');
    return this.types.create({
      code:        dto.code,
      title:       dto.title,
      description: dto.description,
    });
  }

  private async resolveType(typeCode: string): Promise<LookupTypeRow> {
    const type = await this.types.findByCode(typeCode);
    if (!type) throw new NotFoundException('LOOKUP_TYPE_NOT_FOUND');
    return type;
  }

  // ── Values ────────────────────────────────────────────────────────────────

  /** Dropdown: global + this store's active, non-hidden values (BR-3). */
  async listValues(typeCode: string, storeId: string): Promise<LookupValueRow[]> {
    const type = await this.resolveType(typeCode);
    return this.lookups.listByType(type.id, storeId);
  }

  /**
   * Global-only values for a type — no store context required. Used by flows
   * that run before a store exists (e.g. the create-store wizard's category /
   * GST-registration-type / state dropdowns) — store-custom values are never
   * returned here since there's no store to scope them to.
   */
  async listGlobalValues(typeCode: string): Promise<LookupValueRow[]> {
    const type = await this.resolveType(typeCode);
    return this.lookups.listByType(type.id, null);
  }

  /** Add a store-custom value (is_system=false) — owner-gated by RBAC (BR-2). */
  async addValue(
    typeCode: string,
    storeId: string,
    actorUserId: string,
    dto: CreateLookupValueDto,
  ): Promise<LookupValueRow> {
    const type = await this.resolveType(typeCode);
    if (await this.lookups.existsByTypeAndCode(type.id, dto.code)) {
      throw new ConflictException('LOOKUP_CODE_EXISTS');
    }
    return this.lookups.insertValue({
      lookupTypeFk: type.id,
      storeFk:      storeId,
      code:         dto.code,
      label:        dto.label,
      description:  dto.description,
      sortOrder:    dto.sort_order ?? 0,
      isSystem:     false,
      createdBy:    actorUserId,
      updatedBy:    actorUserId,
    });
  }

  /** Load a value and assert it belongs to this store and isn't protected. */
  private async loadEditableValue(guuid: string, storeId: string): Promise<LookupValueRow> {
    const value = await this.lookups.findByGuuid(guuid);
    // A value from another store (or a global one) is invisible here, not just
    // forbidden — don't leak cross-tenant existence (tenant isolation).
    if (!value || value.storeFk !== storeId) {
      throw new NotFoundException('LOOKUP_VALUE_NOT_FOUND');
    }
    if (value.isSystem) throw new ForbiddenException('LOOKUP_VALUE_PROTECTED');
    return value;
  }

  async updateValue(
    guuid: string,
    storeId: string,
    actorUserId: string,
    dto: UpdateLookupValueDto,
  ): Promise<LookupValueRow> {
    await this.loadEditableValue(guuid, storeId);
    const row = await this.lookups.updateValue(guuid, {
      label:       dto.label,
      description: dto.description,
      sortOrder:   dto.sort_order,
      isHidden:    dto.is_hidden,
      updatedBy:   actorUserId,
    });
    return row!;
  }

  async softDeleteValue(guuid: string, storeId: string): Promise<void> {
    await this.loadEditableValue(guuid, storeId);
    await this.lookups.softDeleteValue(guuid);
  }
}
