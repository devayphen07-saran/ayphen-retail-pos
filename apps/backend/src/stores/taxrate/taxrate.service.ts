import { Injectable } from '@nestjs/common';
import { ConflictError, NotFoundError } from '#common/exceptions/app.exception.js';
import { ErrorCodes } from '#common/error-codes.js';
import { UnitOfWork } from '#db/db.module.js';
import { rethrowUniqueViolationAs } from '#db/rethrow-unique-violation.js';
import { AuditService } from '#common/audit/audit.service.js';
import { TaxRateRepository, type TaxRateRow } from './taxrate.repository.js';

export interface TaxRateInput {
  name:        string;
  ratePercent: number;
  isInclusive: boolean;
}

/** Round a percentage to the DB's `numeric(6,3)` scale and return the string
 *  drizzle's `numeric` column expects — never a JS float. A client sending more
 *  precision is normalized here rather than rejected. */
function toRateString(pct: number): string {
  // Round to the target scale first — pct.toFixed(3) alone is subject to
  // IEEE-754 binary-representation error at exact half-way points (e.g.
  // 1.0005 can render as "1.000" instead of "1.001"); pre-rounding via
  // Math.round avoids most of those edge cases for this money-adjacent value.
  return (Math.round(pct * 1000) / 1000).toFixed(3);
}

/**
 * Tax-rate lifecycle — online-only, server-authoritative writes. Reads reach
 * devices through the existing sync pull; this service owns create / edit /
 * deactivate. Uniqueness (name per store, live) is DB-enforced by
 * `uk_taxrates_store_name`; the pre-checks below only shape the error text for
 * the non-racing case. Every mutation is store-scoped (the controller's tenant
 * guard has already authorized `storeId`).
 */
@Injectable()
export class TaxRateService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly repo: TaxRateRepository,
    private readonly audit: AuditService,
  ) {}

  listRates(storeId: string): Promise<TaxRateRow[]> {
    return this.repo.listInStore(storeId);
  }

  async getRate(storeId: string, id: string): Promise<TaxRateRow> {
    const row = await this.repo.findInStore(id, storeId);
    if (!row) {
      throw new NotFoundError(ErrorCodes.TAXRATE_NOT_FOUND, 'Tax rate not found');
    }
    return row;
  }

  async create(
    storeId: string,
    actorId: string,
    input: TaxRateInput,
  ): Promise<TaxRateRow> {
    // Pre-check is TOCTOU-able on its own — two concurrent creates of the same
    // name can both pass before either commits. uk_taxrates_store_name is the
    // real guard; normalize its 23505 to the same shape for consistent text.
    if (await this.repo.nameTaken(storeId, input.name, null)) {
      throw new ConflictError(
        ErrorCodes.TAXRATE_ALREADY_EXISTS,
        'A tax rate with this name already exists',
      );
    }
    return rethrowUniqueViolationAs(
      this.uow.execute(async (tx) => {
        const row = await this.repo.create(
          {
            storeFk:     storeId,
            name:        input.name,
            ratePercent: toRateString(input.ratePercent),
            isInclusive: input.isInclusive,
            createdBy:   actorId,
          },
          tx,
        );
        await this.audit.logInTransaction(
          {
            event:        'TAXRATE_CHANGED',
            activityType: 'TAXRATE_CHANGED',
            prefix:       'Tax rate',
            suffix:       `"${input.name}" created`,
            userId:       actorId,
            storeFk:      storeId,
            isSuccess:    true,
            entityType:   'TaxRate',
            entityId:     row.id,
          },
          tx,
        );
        return row;
      }),
      () =>
        new ConflictError(
          ErrorCodes.TAXRATE_ALREADY_EXISTS,
          'A tax rate with this name already exists',
        ),
      'uk_taxrates_store_name',
    );
  }

  async update(
    storeId: string,
    actorId: string,
    id: string,
    input: TaxRateInput & { expectedRowVersion: number },
  ): Promise<TaxRateRow> {
    if (await this.repo.nameTaken(storeId, input.name, id)) {
      throw new ConflictError(
        ErrorCodes.TAXRATE_ALREADY_EXISTS,
        'A tax rate with this name already exists',
      );
    }
    return rethrowUniqueViolationAs(
      this.uow.execute(async (tx) => {
        const updated = await this.repo.updateWithVersion(
          id,
          storeId,
          input.expectedRowVersion,
          {
            name:        input.name,
            ratePercent: toRateString(input.ratePercent),
            isInclusive: input.isInclusive,
          },
          actorId,
          tx,
        );
        if (!updated) {
          // No row matched (id, storeFk, rowVersion) — disambiguate: a missing
          // row is a 404, a present row means the version was stale (someone
          // else edited it since the client loaded the screen) → 409.
          const exists = await this.repo.findInStore(id, storeId, tx);
          if (!exists) {
            throw new NotFoundError(ErrorCodes.TAXRATE_NOT_FOUND, 'Tax rate not found');
          }
          throw new ConflictError(
            ErrorCodes.TAXRATE_VERSION_CONFLICT,
            'This tax rate was changed by someone else — reload and try again',
          );
        }
        await this.audit.logInTransaction(
          {
            event:        'TAXRATE_CHANGED',
            activityType: 'TAXRATE_CHANGED',
            prefix:       'Tax rate',
            suffix:       `"${input.name}" updated`,
            userId:       actorId,
            storeFk:      storeId,
            isSuccess:    true,
            entityType:   'TaxRate',
            entityId:     updated.id,
          },
          tx,
        );
        return updated;
      }),
      () =>
        new ConflictError(
          ErrorCodes.TAXRATE_ALREADY_EXISTS,
          'A tax rate with this name already exists',
        ),
      'uk_taxrates_store_name',
    );
  }

  /** Deactivate (hide from new selection; products keep resolving). Idempotent:
   *  deactivating an already-inactive rate is a no-op success. */
  async deactivate(storeId: string, actorId: string, id: string): Promise<void> {
    await this.uow.execute(async (tx) => {
      const row = await this.repo.deactivate(id, storeId, actorId, tx);
      if (!row) {
        const exists = await this.repo.findInStore(id, storeId, tx);
        if (!exists) {
          throw new NotFoundError(ErrorCodes.TAXRATE_NOT_FOUND, 'Tax rate not found');
        }
        return; // already inactive — nothing to do
      }
      await this.audit.logInTransaction(
        {
          event:        'TAXRATE_CHANGED',
          activityType: 'TAXRATE_CHANGED',
          prefix:       'Tax rate',
          suffix:       `"${row.name}" deactivated`,
          userId:       actorId,
          storeFk:      storeId,
          isSuccess:    true,
          entityType:   'TaxRate',
          entityId:     row.id,
        },
        tx,
      );
    });
  }
}