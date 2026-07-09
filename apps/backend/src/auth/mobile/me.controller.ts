import { Body, Controller, Get, HttpCode, Patch, UseGuards } from '@nestjs/common';
import { MobileJwtGuard } from './guards/mobile-jwt.guard.js';
import { AuthLoginService } from './services/auth-login.service.js';
import { AuthMapper } from './mappers/auth.mapper.js';
import { parse } from '#common/validation/parse.js';
import { AccountModeDtoSchema, type AccountModeDto } from './dto/request/account-mode.request.js';
import { UpdateProfileDtoSchema, type UpdateProfileDto } from './dto/request/update-profile.request.js';
import type { BootstrapResponse, ProfileResponse } from './dto/response/auth.response.js';
import type { MobilePrincipal } from '#common/types/principal.js';
import { CurrentUser, StoreContext } from '#common/rbac/decorators/rbac.decorators.js';

/**
 * Account-level session bootstrap. Cold app launch restores a session via
 * `/auth/mobile/refresh`, which — being a pure token-rotation primitive —
 * returns tokens only, no user profile. This endpoint fills that gap so a
 * refreshed session ends up with the same store state a fresh login gets for
 * free from `LoginResponse.user`.
 */
@Controller('me')
@UseGuards(MobileJwtGuard)
@StoreContext('none')
export class MeController {
  constructor(private readonly loginService: AuthLoginService) {}

  @Get('bootstrap')
  async bootstrap(@CurrentUser() user: MobilePrincipal): Promise<BootstrapResponse> {
    const result = await this.loginService.bootstrap(user);
    return AuthMapper.toBootstrapResponse(result);
  }

  /**
   * Display data for the profile screen (name/email/phone/picture). Always
   * resolved from `@CurrentUser()` — never a path param — so one user can
   * never read another's profile. Deliberately not part of bootstrap/login:
   * this is display data for a screen the user may open rarely, fetched
   * fresh only when it does, not a routing fact needed on every launch.
   */
  @Get('profile')
  async getProfile(@CurrentUser() user: MobilePrincipal): Promise<ProfileResponse> {
    const result = await this.loginService.getProfile(user.userId);
    return AuthMapper.toProfileResponse(result);
  }

  /**
   * Complete-your-profile / edit-profile write path. Currently name/email
   * only — see UpdateProfileDtoSchema's doc comment for why phone is
   * excluded. Returns the updated profile so the client can apply it (and
   * flip its local `profileComplete` gate state) without a second GET.
   */
  @Patch('profile')
  async updateProfile(
    @CurrentUser() user: MobilePrincipal,
    @Body() body: unknown,
  ): Promise<ProfileResponse> {
    const dto: UpdateProfileDto = parse(body, UpdateProfileDtoSchema);
    const result = await this.loginService.updateProfile(user.userId, dto);
    return AuthMapper.toProfileResponse(result);
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
