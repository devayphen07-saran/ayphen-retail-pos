import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { Request } from 'express';
import { Throttle } from '@nestjs/throttler';
import {
  CurrentUser,
  Public,
  StoreContext,
} from '#common/rbac/decorators/rbac.decorators.js';
import { parse } from '#common/validation/parse.js';
import type { PaginatedResponse } from '#common/pagination/paginated-response.js';
import { MobileJwtGuard } from './guards/mobile-jwt.guard.js';
import { SnapshotRefreshInterceptor } from './interceptors/snapshot-refresh.interceptor.js';
import { AuthLoginService } from './services/auth-login.service.js';
import { AuthSignupService } from './services/auth-signup.service.js';
import { AuthLogoutService } from './services/auth-logout.service.js';
import { RefreshTokenService } from './services/refresh-token.service.js';
import { StepUpService } from './services/step-up.service.js';
import { DeviceChallengeService } from './services/device-challenge.service.js';

// ── Request DTOs ──
import {
  OtpRequestDtoSchema,
  OtpVerifyDtoSchema,
  SignupVerifyDtoSchema,
  type OtpRequestDto,
  type OtpVerifyDto,
  type SignupVerifyDto,
} from './dto/request/otp.request.js';
import {
  RefreshDtoSchema,
  type RefreshDto,
  RefreshChallengeDtoSchema,
  type RefreshChallengeDto,
} from './dto/request/refresh.request.js';
import {
  StepUpRequestDtoSchema,
  StepUpVerifyDtoSchema,
  type StepUpVerifyDto,
} from './dto/request/step-up.request.js';
import { SessionListQuerySchema } from './dto/request/session-list.request.js';

// ── Response DTOs ──
import type { OtpChallengeResponse } from './dto/response/otp.response.js';
import type {
  LoginResponse,
  RefreshResponse,
} from './dto/response/auth.response.js';
import type {
  SessionResponse,
  StepUpResponse,
  ChallengeResponse,
} from './dto/response/session.response.js';

// ── Mappers ──
import { AuthMapper } from './mappers/auth.mapper.js';
import { SessionMapper } from './mappers/session.mapper.js';
import { DeviceRequestMapper } from './mappers/device.request-mapper.js';
import type { MobilePrincipal } from '#common/types/principal.js';
import { getRequestIp } from '#common/request-ip.js';

@Controller('auth/mobile')
@StoreContext('none')
export class MobileAuthController {
  constructor(
    private readonly loginService: AuthLoginService,
    private readonly signupService: AuthSignupService,
    private readonly logoutService: AuthLogoutService,
    private readonly tokenService: RefreshTokenService,
    private readonly stepUpService: StepUpService,
    private readonly challenge: DeviceChallengeService,
  ) {}

  // ── LOGIN ──────────────────────────────────────────────────────────────────

  // OTP send triggers an SMS — a coarse per-IP backstop under the per-phone/IP
  // Redis limiters in the service (defence in depth, cluster-wide via Redis storage).
  @Public()
  @Post('login/otp')
  @Throttle({ global: { limit: 5, ttl: 60_000 } })
  @HttpCode(200)
  async loginRequest(
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<OtpChallengeResponse> {
    const dto: OtpRequestDto = parse(body, OtpRequestDtoSchema);
    const result = await this.loginService.loginStageOne(
      dto.phone,
      getRequestIp(req),
      dto.resend_of,
    );
    return AuthMapper.toOtpChallengeResponse(result);
  }

  @Public()
  @Post('login/verify')
  @Throttle({ global: { limit: 10, ttl: 60_000 } })
  @HttpCode(200)
  async loginVerify(
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<LoginResponse> {
    const dto: OtpVerifyDto = parse(body, OtpVerifyDtoSchema);
    const result = await this.loginService.loginStageTwo(
      dto.phone,
      dto.otp_code,
      dto.otp_request_id,
      DeviceRequestMapper.toDomain(dto.device),
      getRequestIp(req),
    );
    return AuthMapper.toLoginResponse(result);
  }

  // ── SIGNUP ─────────────────────────────────────────────────────────────────

  @Public()
  @Post('signup/otp')
  @Throttle({ global: { limit: 5, ttl: 60_000 } })
  @HttpCode(200)
  async signupRequest(
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<OtpChallengeResponse> {
    const dto: OtpRequestDto = parse(body, OtpRequestDtoSchema);
    const result = await this.signupService.signupStageOne(
      dto.phone,
      getRequestIp(req),
    );
    return AuthMapper.toOtpChallengeResponse(result);
  }

  @Public()
  @Post('signup/verify')
  @Throttle({ global: { limit: 10, ttl: 60_000 } })
  @HttpCode(201)
  async signupVerify(
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<LoginResponse> {
    const dto: SignupVerifyDto = parse(body, SignupVerifyDtoSchema);
    const result = await this.signupService.signupStageTwo(
      dto.phone,
      dto.otp_code,
      dto.otp_request_id,
      dto.name,
      DeviceRequestMapper.toDomain(dto.device),
      getRequestIp(req),
    );
    return AuthMapper.toLoginResponse(result);
  }

  // ── REFRESH ────────────────────────────────────────────────────────────────

  /**
   * Device-binding challenge for refresh. PUBLIC by necessity: it runs when the
   * access token has expired (that's why the client is refreshing), so it can't
   * require one. The refresh token in the body identifies the device; the
   * server issues a challenge bound to it, the client signs it, and echoes the
   * signature to `refresh`.
   */
  @Public()
  @Post('refresh/challenge')
  @Throttle({ global: { limit: 30, ttl: 60_000 } })
  @HttpCode(200)
  async refreshChallenge(@Body() body: unknown): Promise<ChallengeResponse> {
    const dto: RefreshChallengeDto = parse(body, RefreshChallengeDtoSchema);
    const challengeId = await this.tokenService.issueRefreshChallenge(
      dto.refresh_token,
    );
    return SessionMapper.toChallengeResponse(challengeId);
  }

  @Public()
  @Post('refresh')
  @Throttle({ global: { limit: 30, ttl: 60_000 } })
  @HttpCode(200)
  async refresh(@Body() body: unknown): Promise<RefreshResponse> {
    const dto: RefreshDto = parse(body, RefreshDtoSchema);
    const result = await this.tokenService.rotate({
      refreshToken: dto.refresh_token,
      challengeId: dto.challenge_id,
      deviceSignature: dto.device_signature,
      snapshotVersion: dto.snapshot_version,
    });
    return AuthMapper.toRefreshResponse(result);
  }

  // ── LOGOUT ─────────────────────────────────────────────────────────────────

  @Post('logout')
  @HttpCode(204)
  @UseGuards(MobileJwtGuard)
  async logout(@CurrentUser() p: MobilePrincipal): Promise<void> {
    await this.logoutService.logout(
      p.userId,
      p.deviceSessionId,
      p.deviceId,
      p.currentJti,
      p.currentJtiExp,
    );
  }

  @Post('logout/all')
  @HttpCode(204)
  @UseGuards(MobileJwtGuard)
  async logoutAll(@CurrentUser() user: MobilePrincipal): Promise<void> {
    await this.logoutService.logoutAll(user.userId);
  }

  // ── SESSIONS ───────────────────────────────────────────────────────────────

  @Get('sessions')
  @UseGuards(MobileJwtGuard)
  @UseInterceptors(SnapshotRefreshInterceptor)
  async listSessions(
    @CurrentUser() p: MobilePrincipal,
    @Query() query: Record<string, unknown>,
  ): Promise<PaginatedResponse<SessionResponse>> {
    const q = parse(query, SessionListQuerySchema);
    const page = await this.logoutService.listSessions(p.userId, {
      limit: q.limit,
      cursor: q.cursor,
    });
    return SessionMapper.toSessionListResponse(page, p.deviceSessionId);
  }

  @Delete('sessions/:sessionId')
  @HttpCode(204)
  @UseGuards(MobileJwtGuard)
  async revokeSession(
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @CurrentUser() user: MobilePrincipal,
  ): Promise<void> {
    await this.logoutService.revokeSession(sessionId, user.userId);
  }

  // ── STEP-UP ────────────────────────────────────────────────────────────────

  @Post('step-up/challenge')
  @UseGuards(MobileJwtGuard)
  async issueChallenge(
    @CurrentUser() user: MobilePrincipal,
  ): Promise<ChallengeResponse> {
    const challengeId = await this.challenge.issueChallenge(user.deviceId);
    return SessionMapper.toChallengeResponse(challengeId);
  }

  @Post('step-up/otp')
  @HttpCode(200)
  @UseGuards(MobileJwtGuard)
  async stepUpOtpRequest(
    @Body() body: unknown,
    @CurrentUser() user: MobilePrincipal,
    @Req() req: Request,
  ): Promise<OtpChallengeResponse> {
    // Validate the body shape but IGNORE any client-supplied phone — step-up
    // OTP always targets the authenticated user's own registered number.
    parse(body, StepUpRequestDtoSchema);
    const result = await this.loginService.stepUpStageOne(
      user.userId,
      getRequestIp(req),
    );
    return AuthMapper.toOtpChallengeResponse(result);
  }

  @Post('step-up/verify')
  @HttpCode(200)
  @UseGuards(MobileJwtGuard)
  async stepUpVerify(
    @Body() body: unknown,
    @CurrentUser() p: MobilePrincipal,
  ): Promise<StepUpResponse> {
    const dto: StepUpVerifyDto = parse(body, StepUpVerifyDtoSchema);
    const result = await this.stepUpService.verify(
      p.userId,
      p.deviceSessionId,
      {
        method: dto.method,
        credential: dto.credential,
        otpRequestId: dto.otp_request_id,
        challengeId: dto.challenge_id,
        intendedWindowSeconds: dto.intended_window_seconds,
      },
    );
    return SessionMapper.toStepUpResponse(result);
  }
}
