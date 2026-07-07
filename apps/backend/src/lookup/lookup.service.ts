import { Injectable } from '@nestjs/common';
import { rethrowUniqueViolationAs } from '#db/rethrow-unique-violation.js';
import { UnitOfWork } from '#db/db.module.js';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '#common/exceptions/app.exception.js';
import { ErrorCodes } from '#common/error-codes.js';
import { AuditService } from '#common/audit/audit.service.js';
import { LookupRepository, type LookupValueRow } from './lookup.repository.js';
import { LookupTypeRepository, type LookupTypeRow } from './lookup-type.repository.js';

/** camelCase commands the LookupService consumes (layered-architecture §3.7). */
export interface CreateLookupTypeCommand {
  code:         string;
  title:        string;
  description?: string;
}

export interface CreateLookupValueCommand {
  code:         string;
  label:        string;
  description?: string;
  sortOrder?:   number;
}

export interface UpdateLookupValueCommand {
  label?:       string;
  description?: string;
  sortOrder?:   number;
  isHidden?:    boolean;
  expectedRowVersion: number;
}

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
    private readonly audit: AuditService,
    private readonly uow: UnitOfWork,
  ) {}

  // ── Types ─────────────────────────────────────────────────────────────────

  listTypes(): Promise<LookupTypeRow[]> {
    return this.types.listAll();
  }

  async createType(actorUserId: string, command: CreateLookupTypeCommand): Promise<LookupTypeRow> {
    // The findByCode check above is TOCTOU-able by itself — two concurrent
    // creates for the same code can both pass it before either commits. The
    // DB's unique constraint on lookup_type.code (schema.ts) is the real
    // guard; normalize its violation to the same LOOKUP_CODE_EXISTS shape.
    const existing = await this.types.findByCode(command.code);
    if (existing)
      throw new ConflictError(ErrorCodes.LOOKUP_CODE_EXISTS, 'A lookup with this code already exists');
    return rethrowUniqueViolationAs(
      this.uow.execute(async (tx) => {
        const row = await this.types.create(
          {
            code:        command.code,
            title:       command.title,
            description: command.description,
          },
          tx,
        );
        await this.audit.logInTransaction({
          event: 'LOOKUP_TYPE_CREATED',
          activityType: 'LOOKUP_CHANGED',
          prefix: 'Lookup type',
          suffix: `"${row.code}" created`,
          userId: actorUserId,
          isSuccess: true,
          entityType: 'Lookup',
          entityId: row.id,
        }, tx);
        return row;
      }),
      () => new ConflictError(ErrorCodes.LOOKUP_CODE_EXISTS, 'A lookup with this code already exists'),
    );
  }

  private async resolveType(typeCode: string): Promise<LookupTypeRow> {
    const type = await this.types.findByCode(typeCode);
    if (!type) throw new NotFoundError(ErrorCodes.LOOKUP_TYPE_NOT_FOUND, 'Lookup type not found');
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
    command: CreateLookupValueCommand,
  ): Promise<LookupValueRow> {
    const type = await this.resolveType(typeCode);
    // Same TOCTOU shape as createType above — existsByTypeAndCode is a
    // pre-check, uk_lookup_type_code (schema.ts) is the real guard.
    if (await this.lookups.existsByTypeAndCode(type.id, command.code)) {
      throw new ConflictError(ErrorCodes.LOOKUP_CODE_EXISTS, 'A lookup value with this code already exists');
    }
    return rethrowUniqueViolationAs(
      this.uow.execute(async (tx) => {
        const row = await this.lookups.insertValue(
          {
            lookupTypeFk: type.id,
            storeFk:      storeId,
            code:         command.code,
            label:        command.label,
            description:  command.description,
            sortOrder:    command.sortOrder ?? 0,
            isSystem:     false,
            createdBy:    actorUserId,
            updatedBy:    actorUserId,
          },
          tx,
        );
        await this.audit.logInTransaction({
          event: 'LOOKUP_VALUE_CREATED',
          activityType: 'LOOKUP_CHANGED',
          prefix: 'Lookup value',
          suffix: `"${row.code}" added to ${typeCode}`,
          userId: actorUserId,
          storeFk: storeId,
          isSuccess: true,
          entityType: 'Lookup',
          entityId: row.guuid,
        }, tx);
        return row;
      }),
      () => new ConflictError(ErrorCodes.LOOKUP_CODE_EXISTS, 'A lookup value with this code already exists'),
    );
  }

  /** Load a value and assert it belongs to this store and isn't protected. */
  private async loadEditableValue(guuid: string, storeId: string): Promise<LookupValueRow> {
    const value = await this.lookups.findByGuuid(guuid);
    // A value from another store (or a global one) is invisible here, not just
    // forbidden — don't leak cross-tenant existence (tenant isolation).
    if (!value || value.storeFk !== storeId) {
      throw new NotFoundError(ErrorCodes.LOOKUP_VALUE_NOT_FOUND, 'Lookup value not found');
    }
    if (value.isSystem)
      throw new ForbiddenError(
        ErrorCodes.LOOKUP_VALUE_PROTECTED,
        'This lookup value is system-protected and cannot be modified',
      );
    return value;
  }

  async updateValue(
    guuid: string,
    storeId: string,
    actorUserId: string,
    command: UpdateLookupValueCommand,
  ): Promise<LookupValueRow> {
    await this.loadEditableValue(guuid, storeId);
    return this.uow.execute(async (tx) => {
      const row = await this.lookups.updateValue(
        guuid,
        storeId,
        command.expectedRowVersion,
        {
          label:       command.label,
          description: command.description,
          sortOrder:   command.sortOrder,
          isHidden:    command.isHidden,
          updatedBy:   actorUserId,
        },
        tx,
      );
      if (!row) {
        // loadEditableValue confirmed existence a moment ago, but the atomic
        // UPDATE (guuid + store + row_version) matched nothing — either a
        // concurrent soft-delete removed it, or someone else's edit already
        // moved the row_version past what this caller last read. Re-fetch to
        // tell the two apart instead of collapsing both into "not found".
        const current = await this.lookups.findByGuuid(guuid, tx);
        if (!current || current.storeFk !== storeId) {
          throw new NotFoundError(ErrorCodes.LOOKUP_VALUE_NOT_FOUND, 'Lookup value not found');
        }
        throw new ConflictError(
          ErrorCodes.LOOKUP_VALUE_VERSION_CONFLICT,
          'This lookup value was changed by someone else — refresh and try again',
          { currentRowVersion: current.rowVersion },
        );
      }
      await this.audit.logInTransaction({
        event: 'LOOKUP_VALUE_UPDATED',
        activityType: 'LOOKUP_CHANGED',
        prefix: 'Lookup value',
        suffix: `"${row.code}" updated`,
        userId: actorUserId,
        storeFk: storeId,
        isSuccess: true,
        entityType: 'Lookup',
        entityId: row.guuid,
      }, tx);
      return row;
    });
  }

  async softDeleteValue(guuid: string, storeId: string, actorUserId: string): Promise<void> {
    const value = await this.loadEditableValue(guuid, storeId);
    await this.uow.execute(async (tx) => {
      await this.lookups.softDeleteValue(guuid, storeId, tx);
      await this.audit.logInTransaction({
        event: 'LOOKUP_VALUE_DELETED',
        activityType: 'LOOKUP_CHANGED',
        prefix: 'Lookup value',
        suffix: `"${value.code}" removed`,
        userId: actorUserId,
        storeFk: storeId,
        isSuccess: true,
        entityType: 'Lookup',
        entityId: value.guuid,
      }, tx);
    });
  }
}
