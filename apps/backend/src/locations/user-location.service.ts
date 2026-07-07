import { Injectable } from '@nestjs/common';
import { UnitOfWork } from '#db/db.module.js';
import { ForbiddenError, NotFoundError } from '#common/exceptions/app.exception.js';
import { ErrorCodes } from '#common/error-codes.js';
import { RbacService } from '#common/rbac/rbac.service.js';
import { AuditService } from '#common/audit/audit.service.js';
import { LocationRepository } from './location.repository.js';
import { UserLocationRepository, type LocationMember } from './user-location.repository.js';

/**
 * User↔location assignment (adoption §8.1). A store-scoped role says WHAT a user
 * can do; this says WHERE. Assigning/revoking bumps the target's permissions
 * version so their device re-bootstraps its location set (H-6). Owners are
 * implicitly assigned to every location and cannot be revoked from one.
 */
@Injectable()
export class UserLocationService {
  constructor(
    private readonly locationRepo: LocationRepository,
    private readonly repo: UserLocationRepository,
    private readonly rbac: RbacService,
    private readonly audit: AuditService,
    private readonly uow: UnitOfWork,
  ) {}

  async listMembers(storeId: string, locationId: string): Promise<LocationMember[]> {
    const loc = await this.locationRepo.findInStore(locationId, storeId);
    if (!loc) throw new NotFoundError(ErrorCodes.LOCATION_NOT_FOUND, 'Location not found');
    return this.repo.listMembers(locationId, storeId);
  }

  /** Assign users to a location. Each must be an active member of the store. */
  async assignUsers(
    storeId: string,
    actorId: string,
    locationId: string,
    userIds: string[],
  ): Promise<void> {
    const loc = await this.locationRepo.findInStore(locationId, storeId);
    if (!loc) throw new NotFoundError(ErrorCodes.LOCATION_NOT_FOUND, 'Location not found');
    if (!loc.enable)
      throw new ForbiddenError(ErrorCodes.LOCATION_DISABLED, 'This location is disabled');

    const members = await this.repo.isStoreMemberBatch(userIds, storeId);
    const nonMember = userIds.find((id) => !members.has(id));
    if (nonMember) {
      throw new ForbiddenError(
        ErrorCodes.USER_NOT_STORE_MEMBER,
        'User is not a member of this store',
      );
    }

    await this.uow.execute(async (tx) => {
      await this.repo.assignManyUsers(userIds, locationId, actorId, tx);
      await this.rbac.bumpPermissionsVersionForUsers(userIds, tx);
      await this.audit.logInTransaction({
        event: 'LOCATION_USERS_ASSIGNED', activityType: 'ROLE_ASSIGNMENT_CREATED',
        prefix: 'Location', suffix: `assigned ${userIds.length} user(s)`,
        userId: actorId, storeFk: storeId, isSuccess: true,
        entityType: 'Location', entityId: locationId,
        metadata: { userIds },
      }, tx);
    });

    await this.rbac.invalidateUserStoreCacheForUsers(userIds, storeId);
  }

  /** Revoke a user from a location. Owners cannot be removed (§8.1). */
  async revokeUser(
    storeId: string,
    actorId: string,
    locationId: string,
    targetUserId: string,
  ): Promise<void> {
    const loc = await this.locationRepo.findInStore(locationId, storeId);
    if (!loc) throw new NotFoundError(ErrorCodes.LOCATION_NOT_FOUND, 'Location not found');

    if (await this.repo.isStoreOwner(targetUserId, storeId)) {
      throw new ForbiddenError(
        ErrorCodes.OWNER_LOCATION_CANNOT_REMOVE,
        'The store owner cannot be removed from a location',
      );
    }

    const revoked = await this.uow.execute(async (tx) => {
      const n = await this.repo.revoke(targetUserId, locationId, storeId, tx);
      if (n > 0) {
        await this.rbac.bumpPermissionsVersionForUser(targetUserId, tx);
        await this.audit.logInTransaction({
          event: 'LOCATION_USER_REVOKED', activityType: 'ROLE_ASSIGNMENT_REVOKED',
          prefix: 'Location', suffix: 'user revoked',
          userId: actorId, storeFk: storeId, isSuccess: true,
          entityType: 'Location', entityId: locationId,
          metadata: { targetUserId },
        }, tx);
      }
      return n;
    });
    if (!revoked)
      throw new NotFoundError(
        ErrorCodes.LOCATION_ASSIGNMENT_NOT_FOUND,
        'Location assignment not found',
      );

    await this.rbac.invalidateUserStoreCache(targetUserId, storeId);
  }
}
