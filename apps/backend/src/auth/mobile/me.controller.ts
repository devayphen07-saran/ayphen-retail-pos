import { Body, Controller, Get, HttpCode, Patch, UseGuards } from '@nestjs/common';
import { MobileJwtGuard } from './guards/mobile-jwt.guard.js';
import { AuthLoginService } from './services/auth-login.service.js';
import { AuthMapper } from './mappers/auth.mapper.js';
import { parse } from '#common/validation/parse.js';
import { AccountModeDtoSchema, type AccountModeDto } from './dto/request/account-mode.request.js';
import type { BootstrapResponse } from './dto/response/auth.response.js';
import type { MobilePrincipal } from '#common/types/principal.js';
import { CurrentUser } from '#common/rbac/decorators/rbac.decorators.js';

/**
 * Account-level session bootstrap. Cold app launch restores a session via
 * `/auth/mobile/refresh`, which — being a pure token-rotation primitive —
 * returns tokens only, no user profile. This endpoint fills that gap so a
 * refreshed session ends up with the same store state a fresh login gets for
 * free from `LoginResponse.user`.
 */
@Controller('me')
@UseGuards(MobileJwtGuard)
export class MeController {
  constructor(private readonly loginService: AuthLoginService) {}

  @Get('bootstrap')
  async bootstrap(@CurrentUser() user: MobilePrincipal): Promise<BootstrapResponse> {
    const result = await this.loginService.bootstrap(user);
    return AuthMapper.toBootstrapResponse(result);
  }

  /** Set business/personal workspace mode (mobile-03 §3c/3d). */
  @Patch('account-mode')
  @HttpCode(204)
  async setAccountMode(
    @CurrentUser() user: MobilePrincipal,
    @Body() body: unknown,
  ): Promise<void> {
    const dto: AccountModeDto = parse(body, AccountModeDtoSchema);
    await this.loginService.updateAccountMode(user.userId, dto.mode);
  }
}
