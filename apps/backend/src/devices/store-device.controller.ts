import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { MobileJwtGuard } from '#auth/mobile/guards/mobile-jwt.guard.js';
import { TenantGuard } from '#common/rbac/guards/tenant.guard.js';
import { PermissionsGuard } from '#common/rbac/guards/permissions.guard.js';
import { SubscriptionStatusGuard } from '#auth/mobile/guards/subscription-status.guard.js';
import {
  StoreContext,
  RequirePermissions,
  CurrentUser,
  CurrentStoreContext,
} from '#common/rbac/decorators/rbac.decorators.js';
import type { MobilePrincipal } from '#auth/mobile/types/mobile-principal.js';
import type { ResolvedStoreContext } from '#common/rbac/resolved-store-context.js';
import { DeviceAccessService } from './device-access.service.js';
import {
  StoreDeviceMapper,
  type StoreDeviceResponse,
  type SlotClaimResponse,
} from './device.mapper.js';

/**
 * Store-scoped device management (device-management §7 F2, §9 F4, §10 F5).
 * Guard chain: auth → tenant (resolves store + accountId) → permissions → sub.
 * The /access slot claim is allowed for any store member (no @RequirePermissions);
 * list/remove are gated on the Device entity per the RBAC matrix (§23).
 */
@Controller('stores/:storeId/devices')
@UseGuards(MobileJwtGuard, TenantGuard, PermissionsGuard, SubscriptionStatusGuard)
@StoreContext('param.storeId')
export class StoreDeviceController {
  constructor(private readonly access: DeviceAccessService) {}

  /** List devices that have accessed this store (owner/manager view, F4). */
  @Get()
  @RequirePermissions({ entity: 'Device', action: 'view' })
  async list(
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @CurrentUser() user: MobilePrincipal,
  ): Promise<StoreDeviceResponse[]> {
    const rows = await this.access.listStoreDevices(storeId);
    return StoreDeviceMapper.toStoreDeviceList(rows, user.deviceId);
  }

  /** Remove a device from this store (owner only, F5). */
  @Delete(':deviceId')
  @HttpCode(204)
  @RequirePermissions({ entity: 'Device', action: 'delete' })
  async remove(
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Param('deviceId', ParseUUIDPipe) deviceId: string,
    @CurrentUser() user: MobilePrincipal,
  ): Promise<void> {
    await this.access.removeDevice(storeId, user.userId, user.deviceId, deviceId);
  }
}

/**
 * Store access / slot claim (F2). Separate controller so it carries @StoreContext
 * (for accountId → device limit) but NOT @RequirePermissions — opening a store is
 * allowed for any member; the gate is the device *count*, not a CRUD permission.
 */
@Controller('stores/:storeId/access')
@UseGuards(MobileJwtGuard, TenantGuard, SubscriptionStatusGuard)
@StoreContext('param.storeId')
export class StoreAccessController {
  constructor(private readonly access: DeviceAccessService) {}

  /** Claim (or refresh) this device's slot. Empty body — device from auth context. */
  @Post()
  async open(
    @CurrentUser() user: MobilePrincipal,
    @CurrentStoreContext() ctx: ResolvedStoreContext,
  ): Promise<SlotClaimResponse> {
    const result = await this.access.claimSlot(
      ctx.storeId,
      ctx.accountId,
      user.deviceId,
      user.userId,
    );
    return StoreDeviceMapper.toSlotClaimResponse(result);
  }
}
