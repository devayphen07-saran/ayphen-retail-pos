import { Module } from '@nestjs/common';

// Providers
import { SessionCacheInvalidatorService } from './services/session-cache-invalidator.service.js';
import { BlacklistCacheService } from './services/blacklist-cache.service.js';
import { ReplayProtectionService } from './services/replay-protection.service.js';
import { DeviceChallengeService } from './services/device-challenge.service.js';
import { DeviceService } from './services/device.service.js';
import { OtpService } from './services/otp.service.js';
import { OtpRequestService } from './services/otp-request.service.js';
import { RefreshIdempotencyService } from './services/refresh-idempotency.service.js';
import { RefreshTokenService } from './services/refresh-token.service.js';
import { StepUpService } from './services/step-up.service.js';
import { SnapshotService } from './services/snapshot.service.js';
import { TokenCleanupService } from './services/token-cleanup.service.js';
import { AuthLoginService } from './services/auth-login.service.js';
import { AuthSignupService } from './services/auth-signup.service.js';
import { AuthLogoutService } from './services/auth-logout.service.js';
import { AccountBootstrapService } from './services/account-bootstrap.service.js';

// Repositories
import { OtpRequestRepository } from './repositories/otp-request.repository.js';
import { DeviceRepository } from './repositories/device.repository.js';
import { AuthSessionRepository } from './repositories/auth-session.repository.js';
import { RefreshTokenRepository } from './repositories/refresh-token.repository.js';
import { UserRepository } from './repositories/user.repository.js';
import { InvitationLookupRepository } from './repositories/invitation-lookup.repository.js';
import { AccountBootstrapRepository } from './repositories/account-bootstrap.repository.js';

// Guard, Interceptor, Controller
import { MobileJwtGuard } from './guards/mobile-jwt.guard.js';
import { SnapshotRefreshInterceptor } from './interceptors/snapshot-refresh.interceptor.js';
import { MobileAuthController } from './mobile-auth.controller.js';
import { MeController } from './me.controller.js';

@Module({
  controllers: [MobileAuthController, MeController],
  providers: [
    // Repositories
    OtpRequestRepository,
    DeviceRepository,
    AuthSessionRepository,
    RefreshTokenRepository,
    UserRepository,
    InvitationLookupRepository,
    AccountBootstrapRepository,

    // Services
    SessionCacheInvalidatorService,
    BlacklistCacheService,
    ReplayProtectionService,
    DeviceChallengeService,
    DeviceService,
    OtpService,
    OtpRequestService,
    RefreshIdempotencyService,
    RefreshTokenService,
    StepUpService,
    SnapshotService,
    TokenCleanupService,
    AuthLoginService,
    AuthSignupService,
    AuthLogoutService,
    AccountBootstrapService,

    // Guard & Interceptor
    MobileJwtGuard,
    SnapshotRefreshInterceptor,
  ],
  exports: [
    MobileJwtGuard,
    // MobileJwtGuard's module-scoped deps, so other modules that apply the guard
    // (e.g. StoresModule) can instantiate it in their own injector.
    BlacklistCacheService,
    ReplayProtectionService,
    SnapshotRefreshInterceptor,
    AuthSessionRepository,
    // Mutations that change permissions (store create, invitation accept)
    // must invalidate the cached bootstrap snapshot, or the client keeps
    // seeing stale data until SNAPSHOT_CACHE_TTL_SECONDS expires.
    SnapshotService,
    // Device block/remove (DevicesModule) must drop the session cache after
    // revoking sessions, or a "removed" device's session stays live in Redis
    // for up to SESSION_CACHE_TTL seconds.
    SessionCacheInvalidatorService,
  ],
})
export class MobileAuthModule {}
