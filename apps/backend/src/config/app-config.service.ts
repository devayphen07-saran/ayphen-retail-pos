import { Injectable } from '@nestjs/common';
import { env, type Env } from './env';

@Injectable()
export class AppConfigService {
  private readonly c: Env = env;

  get jwtAccessSecret():   string  { return this.c.JWT_ACCESS_SECRET; }
  get jwtRefreshSecret():  string  { return this.c.JWT_REFRESH_SECRET; }
  get redisUrl():          string  { return this.c.REDIS_URL ?? ''; }
  /** Sync root secret — derivation inputs are domain-separated, so the JWT fallback never signs cursors directly. */
  get syncRootSecret():    string  { return this.c.SYNC_ROOT_SECRET ?? this.c.JWT_ACCESS_SECRET; }
  get isProduction():                   boolean   { return this.c.NODE_ENV === 'production'; }
  get otpTtlSeconds():                  number    { return this.c.OTP_TTL_SECONDS; }
  get otpResendCooldownSeconds():       number    { return this.c.OTP_RESEND_COOLDOWN_SECONDS; }
  get otpMaxAttempts():                 number    { return this.c.OTP_MAX_ATTEMPTS; }
  get ipMaxAttempts():                  number    { return this.c.IP_MAX_ATTEMPTS; }
  get deviceChallengeTtlSeconds():      number    { return this.c.DEVICE_CHALLENGE_TTL_SECONDS; }
  get sessionCacheTtlSeconds():         number    { return this.c.SESSION_CACHE_TTL_SECONDS; }
  get refreshTokenTtlSeconds():         number    { return this.c.REFRESH_TOKEN_TTL_SECONDS; }
  get accessTokenTtlSeconds():          number    { return this.c.ACCESS_TOKEN_TTL_SECONDS; }
  get snapshotCacheTtlSeconds():        number    { return this.c.SNAPSHOT_CACHE_TTL_SECONDS; }
  get stepUpValiditySeconds():          number    { return this.c.STEP_UP_VALIDITY_SECONDS; }
  get stepUpRateWindowSeconds():        number    { return this.c.STEP_UP_RATE_WINDOW_SECONDS; }
  get stepUpMaxAttempts():              number    { return this.c.STEP_UP_MAX_ATTEMPTS; }
  get maxPasswordLength():              number    { return this.c.MAX_PASSWORD_LENGTH; }
  get maxFailedLoginAttempts():         number    { return this.c.MAX_FAILED_LOGIN_ATTEMPTS; }
  get accountLockoutDurationMinutes():  number    { return this.c.ACCOUNT_LOCKOUT_DURATION_MINUTES; }
  get msg91AuthKey():                   string    { return this.c.MSG91_AUTH_KEY ?? ''; }
  get msg91TemplateId():                string    { return this.c.MSG91_TEMPLATE_ID ?? ''; }
  get razorpayKeyId():                  string    { return this.c.RAZORPAY_KEY_ID ?? ''; }
  get razorpayKeySecret():              string    { return this.c.RAZORPAY_KEY_SECRET ?? ''; }
  get razorpayWebhookSecret():          string    { return this.c.RAZORPAY_WEBHOOK_SECRET ?? ''; }
  get razorpayConfigured():             boolean   {
    return Boolean(this.c.RAZORPAY_KEY_ID && this.c.RAZORPAY_KEY_SECRET && this.c.RAZORPAY_WEBHOOK_SECRET);
  }
  get cronTokenCleanup():                string    { return this.c.CRON_TOKEN_CLEANUP; }
  get cronDeviceAutoExpiry():             string    { return this.c.CRON_DEVICE_AUTO_EXPIRY; }
  get cronLoginAttemptsCleanup():         string    { return this.c.CRON_LOGIN_ATTEMPTS_CLEANUP; }
  get loginAttemptsRetentionDays():       number    { return this.c.LOGIN_ATTEMPTS_RETENTION_DAYS; }
  get cronSubscriptionReconciliation():   string    { return this.c.CRON_SUBSCRIPTION_RECONCILIATION; }
  get cronTempFileSweep():                string    { return this.c.CRON_TEMP_FILE_SWEEP; }

  // ── Files & object storage (table-architecture §33) ─────────────────────
  get uploadMaxFileSizeBytes():           number    { return this.c.UPLOAD_MAX_FILE_SIZE_MB * 1024 * 1024; }
  get uploadMaxFilesPerRequest():         number    { return this.c.UPLOAD_MAX_FILES_PER_REQUEST; }
  get storageBucket():                    string    { return this.c.STORAGE_BUCKET ?? ''; }
  get storageRegion():                    string    { return this.c.STORAGE_REGION; }
  get storageEndpoint():                  string    { return this.c.STORAGE_ENDPOINT ?? ''; }
  get storageAccessKeyId():               string    { return this.c.STORAGE_ACCESS_KEY_ID ?? ''; }
  get storageSecretAccessKey():           string    { return this.c.STORAGE_SECRET_ACCESS_KEY ?? ''; }
  get storageForcePathStyle():            boolean   { return this.c.STORAGE_FORCE_PATH_STYLE; }
  get storageLocalDir():                  string    { return this.c.STORAGE_LOCAL_DIR; }
  get storageSignedUrlTtlSeconds():       number    { return this.c.STORAGE_SIGNED_URL_TTL_SECONDS; }
  get tempFileTtlHours():                 number    { return this.c.TEMP_FILE_TTL_HOURS; }
  get publicBaseUrl():                    string    { return this.c.PUBLIC_BASE_URL; }
  /** True when a real object store is configured; otherwise the on-disk dev provider is bound. */
  get storageConfigured():                boolean   { return Boolean(this.c.STORAGE_BUCKET); }
}
