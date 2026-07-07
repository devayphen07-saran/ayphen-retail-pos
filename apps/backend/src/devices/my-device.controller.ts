import {
  Controller,
  HttpCode,
  Param,
  Patch,
  Get,
  ParseUUIDPipe,
  UseGuards,
} from '@nestjs/common';
import { MobileJwtGuard } from '#auth/mobile/guards/mobile-jwt.guard.js';
import { CurrentUser, StoreContext } from '#common/rbac/decorators/rbac.decorators.js';
import type { MobilePrincipal } from '#common/types/principal.js';
import { DeviceAccessService } from './device-access.service.js';
import { StoreDeviceMapper, type MyDeviceResponse } from './device.mapper.js';

/**
 * User-level device management (device-management §12 F7, §13 F8, §14 F9). Own
 * devices only — MobileJwtGuard, no store scope. Block/unblock affect the device
 * globally (all stores).
 */
@Controller('devices')
@UseGuards(MobileJwtGuard)
@StoreContext('none')
export class MyDeviceController {
  constructor(private readonly access: DeviceAccessService) {}

  /** All devices registered to the current user, across all stores (F7). */
  @Get('my')
  async myDevices(@CurrentUser() user: MobilePrincipal): Promise<MyDeviceResponse[]> {
    const devices = await this.access.listMyDevices(user.userId);
    return StoreDeviceMapper.toMyDeviceList(devices, user.deviceId);
  }

  /** Block a stolen/lost device — global kill (F8). */
  @Patch(':deviceId/block')
  @HttpCode(204)
  async block(
    @Param('deviceId', ParseUUIDPipe) deviceId: string,
    @CurrentUser() user: MobilePrincipal,
  ): Promise<void> {
    await this.access.blockDevice(user.userId, deviceId);
  }

  /** Unblock a recovered device (F9). */
  @Patch(':deviceId/unblock')
  @HttpCode(204)
  async unblock(
    @Param('deviceId', ParseUUIDPipe) deviceId: string,
    @CurrentUser() user: MobilePrincipal,
  ): Promise<void> {
    await this.access.unblockDevice(user.userId, deviceId);
  }
}
