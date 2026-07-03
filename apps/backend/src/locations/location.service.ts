import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { UnitOfWork } from '#db/db.module.js';
import { EntitlementService } from '../subscription/entitlement.service.js';
import { AuditService } from '#auth/core/audit.service.js';
import { LocationRepository, type Location } from './location.repository.js';

export interface CreateLocationInput {
  name:       string;
  isDefault?: boolean;
}

export interface UpdateLocationInput {
  name?:   string;
  enable?: boolean;
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
    private readonly entitlements: EntitlementService,
    private readonly audit: AuditService,
    private readonly uow: UnitOfWork,
  ) {}

  listLocations(storeId: string): Promise<Location[]> {
    return this.repo.listActive(storeId);
  }

  async createLocation(
    storeId: string,
    accountId: string,
    actorId: string,
    input: CreateLocationInput,
  ): Promise<{ id: string; name: string }> {
    // Multi-location must be enabled on the plan (seeded feature key: multi_store).
    if (!(await this.entitlements.feature(accountId, 'multi_store'))) {
      throw new ForbiddenException('MULTI_LOCATION_NOT_AVAILABLE');
    }

    // max_locations_per_store gate (Head Office counts as slot 1).
    const limit  = await this.entitlements.get(accountId, 'max_locations_per_store');
    const active = await this.repo.countActive(storeId);
    if (!this.entitlements.canCreate(limit, active)) {
      throw new ForbiddenException('LOCATION_LIMIT_REACHED');
    }

    if (await this.repo.nameTaken(storeId, input.name)) {
      throw new ConflictException('LOCATION_NAME_EXISTS');
    }

    const created = await this.uow.execute(async (tx) => {
      const loc = await this.repo.insert(
        { storeFk: storeId, name: input.name, isDefault: input.isDefault ?? false },
        tx,
      );
      // Setting a new default clears any other default (one per store).
      if (loc.isDefault) await this.repo.clearOtherDefaults(storeId, loc.id, tx);
      return loc;
    });

    await this.audit.log({
      event: 'LOCATION_CREATED', activityType: 'PERMISSION_CHANGED',
      prefix: 'Location', suffix: `"${input.name}" created`,
      userId: actorId, storeFk: storeId, isSuccess: true,
      entityType: 'Location', entityId: created.id,
    });
    return { id: created.id, name: created.name };
  }

  async updateLocation(
    storeId: string,
    actorId: string,
    locationId: string,
    input: UpdateLocationInput,
  ): Promise<void> {
    const loc = await this.repo.findInStore(locationId, storeId);
    if (!loc) throw new NotFoundException('LOCATION_NOT_FOUND');

    // Head Office and the default location can never be disabled (§8.2).
    if (input.enable === false) {
      if (loc.isPrimary) throw new ForbiddenException('LOCATION_HEAD_OFFICE_NOT_DISABLE');
      if (loc.isDefault) throw new ForbiddenException('LOCATION_DEFAULT_NOT_DISABLE');
    }

    if (input.name && input.name !== loc.name) {
      if (await this.repo.nameTaken(storeId, input.name, locationId)) {
        throw new ConflictException('LOCATION_NAME_EXISTS');
      }
    }

    await this.repo.update(locationId, { name: input.name, enable: input.enable });
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
    if (!loc) throw new NotFoundException('LOCATION_NOT_FOUND');
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
    if (!loc) throw new NotFoundException('LOCATION_NOT_FOUND');
    if (loc.isPrimary) throw new ForbiddenException('LOCATION_HEAD_OFFICE_NOT_DELETABLE');
    // Deleting the sole default would leave the store with none.
    if (loc.isDefault && (await this.repo.countDefaults(storeId)) <= 1) {
      throw new ForbiddenException('LOCATION_ONLY_DEFAULT');
    }

    await this.repo.softDelete(locationId);
    await this.audit.log({
      event: 'LOCATION_DELETED', activityType: 'PERMISSION_CHANGED',
      prefix: 'Location', suffix: `"${loc.name}" deleted`,
      userId: actorId, storeFk: storeId, isSuccess: true,
      entityType: 'Location', entityId: locationId,
    });
  }
}
