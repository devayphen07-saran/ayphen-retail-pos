import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { parse } from '#common/validation/parse.js';
import { MobileJwtGuard } from '#auth/mobile/guards/mobile-jwt.guard.js';
import { TenantGuard } from '#common/rbac/guards/tenant.guard.js';
import { PermissionsGuard } from '#common/rbac/guards/permissions.guard.js';
import { SubscriptionStatusGuard } from '#auth/mobile/guards/subscription-status.guard.js';
import {
  StoreContext,
  RequirePermissions,
  CurrentUser,
} from '#common/rbac/decorators/rbac.decorators.js';
import type { MobilePrincipal } from '#common/types/principal.js';
import { PaymentAccountService } from './payment-account.service.js';
import {
  CreatePaymentAccountDtoSchema,
  UpdatePaymentAccountDtoSchema,
} from './dto/payment-account.dto.js';
import { PaymentAccountMapper } from './payment-account.mapper.js';
import { PaymentAccountRequestMapper } from './payment-account.request-mapper.js';
import type { PaymentAccountResponse } from './dto/payment-account.response.js';

/**
 * Payment-account management (online REST surface). Reads here are online/
 * authoritative; the offline POS checkout reads the same accounts from the
 * client's local sync cache instead (PRD payment-accounts-mobile §0). Full guard
 * chain: auth → tenant → permissions → subscription. Writes delegate to the sync
 * PaymentAccountMutationHandler so REST and sync enforce identical rules.
 */
@Controller('stores/:storeId/payment-accounts')
@UseGuards(MobileJwtGuard, TenantGuard, PermissionsGuard, SubscriptionStatusGuard)
@StoreContext('param.storeId')
export class PaymentAccountController {
  constructor(private readonly accounts: PaymentAccountService) {}

  @Get()
  @RequirePermissions({ entity: 'Payment', action: 'view' })
  async list(
    @Param('storeId', ParseUUIDPipe) storeId: string,
  ): Promise<PaymentAccountResponse[]> {
    return PaymentAccountMapper.toListResponse(await this.accounts.list(storeId));
  }

  @Post()
  @RequirePermissions({ entity: 'Payment', action: 'create' })
  async create(
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @CurrentUser() user: MobilePrincipal,
    @Body() body: unknown,
  ): Promise<PaymentAccountResponse> {
    const dto = parse(body, CreatePaymentAccountDtoSchema);
    const row = await this.accounts.create(
      storeId,
      { userId: user.userId, deviceId: user.deviceId },
      PaymentAccountRequestMapper.toCreateInput(dto),
    );
    return PaymentAccountMapper.toResponse(row);
  }

  @Patch(':paymentAccountId')
  @RequirePermissions({ entity: 'Payment', action: 'edit' })
  async update(
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Param('paymentAccountId', ParseUUIDPipe) paymentAccountId: string,
    @CurrentUser() user: MobilePrincipal,
    @Body() body: unknown,
  ): Promise<PaymentAccountResponse> {
    const dto = parse(body, UpdatePaymentAccountDtoSchema);
    const row = await this.accounts.update(
      storeId,
      { userId: user.userId, deviceId: user.deviceId },
      paymentAccountId,
      PaymentAccountRequestMapper.toUpdateInput(dto),
    );
    return PaymentAccountMapper.toResponse(row);
  }

  @Delete(':paymentAccountId')
  @HttpCode(204)
  @RequirePermissions({ entity: 'Payment', action: 'delete' })
  async remove(
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Param('paymentAccountId', ParseUUIDPipe) paymentAccountId: string,
    @CurrentUser() user: MobilePrincipal,
  ): Promise<void> {
    await this.accounts.remove(
      storeId,
      { userId: user.userId, deviceId: user.deviceId },
      paymentAccountId,
    );
  }
}
