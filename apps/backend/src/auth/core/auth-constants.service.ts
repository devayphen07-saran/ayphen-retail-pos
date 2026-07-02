import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service.js';

@Injectable()
export class AuthConstantsService {
  constructor(private readonly config: AppConfigService) {}

  get OTP_TTL_SECONDS():                  number { return this.config.otpTtlSeconds; }
  get OTP_RESEND_COOLDOWN_SECONDS():      number { return this.config.otpResendCooldownSeconds; }
  get OTP_MAX_ATTEMPTS():                 number { return this.config.otpMaxAttempts; }
  get DEVICE_CHALLENGE_TTL_SECONDS():     number { return this.config.deviceChallengeTtlSeconds; }
  get SESSION_CACHE_TTL_SECONDS():        number { return this.config.sessionCacheTtlSeconds; }
  get REFRESH_TOKEN_TTL_SECONDS():        number { return this.config.refreshTokenTtlSeconds; }
  get ACCESS_TOKEN_TTL_SECONDS():         number { return this.config.accessTokenTtlSeconds; }
  get SNAPSHOT_CACHE_TTL_SECONDS():       number { return this.config.snapshotCacheTtlSeconds; }
  get STEP_UP_VALIDITY_SECONDS():         number { return this.config.stepUpValiditySeconds; }
  get STEP_UP_RATE_WINDOW_SECONDS():      number { return this.config.stepUpRateWindowSeconds; }
  get STEP_UP_MAX_ATTEMPTS():             number { return this.config.stepUpMaxAttempts; }
  get MAX_PASSWORD_LENGTH():              number { return this.config.maxPasswordLength; }
  get MAX_FAILED_LOGIN_ATTEMPTS():        number { return this.config.maxFailedLoginAttempts; }
  get ACCOUNT_LOCKOUT_DURATION_MINUTES(): number { return this.config.accountLockoutDurationMinutes; }
}
