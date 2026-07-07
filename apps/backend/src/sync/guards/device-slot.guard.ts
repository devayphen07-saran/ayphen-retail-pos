import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { ForbiddenError } from '#common/exceptions/app.exception.js';
import { ErrorCodes } from '#common/error-codes.js';
import { DeviceAccessRepository } from '../../devices/device-access.repository.js';

/**
 * The device-count entitlement (max_devices_per_store) is claimed by
 * `POST /stores/:id/access` (StoreAccessController.claimSlot) — but nothing
 * on the sync surface itself required that call to have happened. A client
 * that simply skips it could pull/push through `/sync/*` from more devices
 * than the plan allows, silently bypassing the paid device-limit feature
 * (the client is never trusted to self-enforce a billing invariant).
 */
@Injectable()
export class DeviceSlotGuard implements CanActivate {
  constructor(private readonly devices: DeviceAccessRepository) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const storeId = req.params?.storeId;
    const deviceId = req.user?.deviceId;
    // Missing identity means MobileJwtGuard/TenantGuard haven't run yet or
    // will reject this request themselves — nothing for this guard to do.
    if (!storeId || !deviceId) return true;

    const slot = await this.devices.findActiveSlot(storeId, deviceId);
    if (!slot) {
      throw new ForbiddenError(
        ErrorCodes.DEVICE_SLOT_REQUIRED,
        'This device has no active access slot for this store — call POST /stores/:storeId/access first',
      );
    }
    return true;
  }
}
