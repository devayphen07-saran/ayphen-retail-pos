import { Injectable } from '@nestjs/common';
import { UnitOfWork } from '#db/db.module.js';
import { rethrowUniqueViolationAs } from '#db/rethrow-unique-violation.js';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '#common/exceptions/app.exception.js';
import { ErrorCodes } from '#common/error-codes.js';
import { EntitlementService } from '../subscription/entitlement.service.js';
import { AuditService } from '#common/audit/audit.service.js';
import { TombstoneRepository } from '../sync/repositories/tombstone.repository.js';
import { LocationRepository, type Location } from './location.repository.js';
import { UserLocationRepository } from './user-location.repository.js';

const nameConflict = () =>
  new ConflictError(ErrorCodes.LOCATION_NAME_EXISTS, 'A location with this name already exists');

export interface CreateLocationInput {
  name:       string;
  isDefault?: boolean;
}

export interface UpdateLocationInput {
  name?:   string;
  enable?: boolean;
}

/** camelCase domain result — exactly what the response mapper needs (§3.1). */
export interface LocationResult {
  id:           string;
  name:         string;
  isPrimary:    boolean;
  isDefault:    boolean;
  enable:       boolean;
  locked:       boolean;
  displayOrder: number;
}

/**
 * Store location management (adoption §8.2). Enforces max_locations_per_store,
 * name uniqueness, and the Head Office / default protections carried over from
 * ayphen-3.0 (LOC_C_NOT_DISABLE / LOC_C_DEFAULT_NOT_DISABLE / LOC_C_ONLY_DEFAULT).
 */
@Injectable()
export class LocationService {
  constructor(
    private readonly repo: LocationRepository,
    private readonly userLocationRepo: UserLocationRepository,
    private readonly entitlements: EntitlementService,
    private readonly audit: AuditService,
    private readonly tombstones: TombstoneRepository,
    private readonly uow: UnitOfWork,
  ) {}

  async listLocations(storeId: string): Promise<LocationResult[]> {
    const rows = await this.repo.listActive(storeId);
    return rows.map((l) => this.toResult(l));
  }

  async createLocation(
    storeId: string,
    accountId: string,
    actorId: string,
    input: CreateLocationInput,
  ): Promise<LocationResult> {
    // max_locations_per_store gate (Head Office counts as slot 1). This single
    // numeric entitlement is the only multi-location gate — a separate
    // 'multi_store' feature flag used to duplicate this check and could
    // disagree with it (e.g. a plan sold with limit=3 but the flag off,
    // making the entitlement unreachable). Removed rather than reconciled:
    // two sources of truth for one rule was the actual defect.
    // Fast pre-check outside the transaction for quick feedback on the
    // common case.
    const precheckLimit  = await this.entitlements.get(accountId, 'max_locations_per_store');
    const precheckActive = await this.repo.countActive(storeId);
    if (!this.entitlements.canCreate(precheckLimit, precheckActive)) {
      throw new ForbiddenError(
        ErrorCodes.LOCATION_LIMIT_REACHED,
        'Location limit reached for this store',
        { limit: precheckLimit, current: precheckActive },
      );
    }

    // Fast-path pre-check — the DB unique index (uk_location_name) is the
    // actual guard against a concurrent create/rename race (see below).
    if (await this.repo.nameTaken(storeId, input.name)) {
      throw nameConflict();
    }

    const created = await rethrowUniqueViolationAs(
      this.uow.execute(async (tx) => {
        // Lock the store row so concurrent creates serialize, then recheck the
        // gate inside the transaction — the pre-check above is TOCTOU-able by
        // itself (two concurrent requests can both pass it before either
        // inserts) — mirrors StoreService.createStore / InvitationService.create.
        await this.repo.lockStore(storeId, tx);
        const limit  = await this.entitlements.get(accountId, 'max_locations_per_store', tx);
        const active = await this.repo.countActive(storeId, tx);
        if (!this.entitlements.canCreate(limit, active)) {
          throw new ForbiddenError(
            ErrorCodes.LOCATION_LIMIT_REACHED,
            'Location limit reached for this store',
            { limit, current: active },
          );
        }
        if (await this.repo.nameTaken(storeId, input.name, undefined, tx)) {
          throw nameConflict();
        }

        const loc = await this.repo.insert(
          { storeFk: storeId, name: input.name, isDefault: input.isDefault ?? false },
          tx,
        );
        // Setting a new default clears any other default (one per store).
        if (loc.isDefault) await this.repo.clearOtherDefaults(storeId, loc.id, tx);
        // The creator isn't implicitly a member of every location the way
        // STORE_OWNER is (location.guard.ts owner bypass) — without this, a
        // non-owner with a granted Location:create permission would create a
        // location it then can't access (LOCATION_ACCESS_DENIED on its own
        // creation).
        await this.userLocationRepo.assign(actorId, loc.id, actorId, tx);
        return loc;
      }),
      nameConflict,
      'uk_location_name',
    );

    await this.audit.log({
      event: 'LOCATION_CREATED', activityType: 'PERMISSION_CHANGED',
      prefix: 'Location', suffix: `"${input.name}" created`,
      userId: actorId, storeFk: storeId, isSuccess: true,
      entityType: 'Location', entityId: created.id,
    });
    return this.toResult(created);
  }

  async updateLocation(
    storeId: string,
    actorId: string,
    locationId: string,
    input: UpdateLocationInput,
  ): Promise<void> {
    const loc = await this.repo.findInStore(locationId, storeId);
    if (!loc) throw new NotFoundError(ErrorCodes.LOCATION_NOT_FOUND, 'Location not found');

    // Head Office and the default location can never be disabled (§8.2).
    if (input.enable === false) {
      if (loc.isPrimary)
        throw new ForbiddenError(
          ErrorCodes.LOCATION_HEAD_OFFICE_NOT_DISABLE,
          'The head office location cannot be disabled',
        );
      if (loc.isDefault)
        throw new ForbiddenError(
          ErrorCodes.LOCATION_DEFAULT_NOT_DISABLE,
          'The default location cannot be disabled',
        );
    }

    if (input.name && input.name !== loc.name) {
      if (await this.repo.nameTaken(storeId, input.name, locationId)) {
        throw nameConflict();
      }
    }

    await rethrowUniqueViolationAs(
      this.repo.update(locationId, { name: input.name, enable: input.enable }),
      nameConflict,
      'uk_location_name',
    );
    await this.audit.log({
      event: 'LOCATION_UPDATED', activityType: 'PERMISSION_CHANGED',
      prefix: 'Location', suffix: 'updated',
      userId: actorId, storeFk: storeId, isSuccess: true,
      entityType: 'Location', entityId: locationId,
    });
  }

  /** Make this location the store default (clears the previous one). */
  async setDefault(storeId: string, actorId: string, locationId: string): Promise<void> {
    const loc = await this.repo.findInStore(locationId, storeId);
    if (!loc) throw new NotFoundError(ErrorCodes.LOCATION_NOT_FOUND, 'Location not found');
    if (loc.isDefault) return; // already default — no-op

    await this.uow.execute(async (tx) => {
      await this.repo.update(locationId, { isDefault: true }, tx);
      await this.repo.clearOtherDefaults(storeId, locationId, tx);
    });
    await this.audit.log({
      event: 'LOCATION_DEFAULT_CHANGED', activityType: 'PERMISSION_CHANGED',
      prefix: 'Location', suffix: 'set as default',
      userId: actorId, storeFk: storeId, isSuccess: true,
      entityType: 'Location', entityId: locationId,
    });
  }

  async deleteLocation(storeId: string, actorId: string, locationId: string): Promise<void> {
    const loc = await this.repo.findInStore(locationId, storeId);
    if (!loc) throw new NotFoundError(ErrorCodes.LOCATION_NOT_FOUND, 'Location not found');
    if (loc.isPrimary)
      throw new ForbiddenError(
        ErrorCodes.LOCATION_HEAD_OFFICE_NOT_DELETABLE,
        'The head office location cannot be deleted',
      );
    // Deleting the sole default would leave the store with none.
    if (loc.isDefault && (await this.repo.countDefaults(storeId)) <= 1) {
      throw new ForbiddenError(
        ErrorCodes.LOCATION_ONLY_DEFAULT,
        'Cannot delete the only default location',
      );
    }

    // Tombstone write is MANDATORY same-tx with the soft-delete (sync-engine.md
    // §8) — writing it outside the transaction risks the row surviving a
    // rollback while the tombstone doesn't (or vice versa), either of which
    // desyncs devices that already cached this location.
    await this.uow.execute(async (tx) => {
      await this.repo.softDelete(locationId, tx);
      await this.tombstones.write(tx, {
        storeFk: storeId,
        entityType: 'location',
        entityGuuid: loc.guuid,
        entityId: locationId,
        deletedByUserFk: actorId,
      });
    });
    await this.audit.log({
      event: 'LOCATION_DELETED', activityType: 'PERMISSION_CHANGED',
      prefix: 'Location', suffix: `"${loc.name}" deleted`,
      userId: actorId, storeFk: storeId, isSuccess: true,
      entityType: 'Location', entityId: locationId,
    });
  }

  /** Persistence entity → the domain result the response mapper consumes. */
  private toResult(l: Location): LocationResult {
    return {
      id:           l.id,
      name:         l.name,
      isPrimary:    l.isPrimary,
      isDefault:    l.isDefault,
      enable:       l.enable,
      locked:       l.locked,
      displayOrder: l.displayOrder,
    };
  }
}
