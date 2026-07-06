import { Injectable } from '@nestjs/common';
import { env, type Env } from './env';

@Injectable()
export class AppConfigService {
  private readonly c: Env = env;

  get port():              number  { return this.c.PORT; }
  get databaseUrl():       string  { return this.c.DATABASE_URL; }
  get jwtAccessSecret():   string  { return this.c.JWT_ACCESS_SECRET; }
  get jwtRefreshSecret():  string  { return this.c.JWT_REFRESH_SECRET; }
  get jwtAccessExpiry():   string  { return this.c.JWT_ACCESS_EXPIRY; }
  get jwtRefreshExpiry():  string  { return this.c.JWT_REFRESH_EXPIRY; }
  get redisUrl():          string  { return this.c.REDIS_URL ?? ''; }
  /** Sync root secret — derivation inputs are domain-separated, so the JWT fallback never signs cursors directly. */
  get syncRootSecret():    string  { return this.c.SYNC_ROOT_SECRET ?? this.c.JWT_ACCESS_SECRET; }
  get smtpHost():          string  { return this.c.SMTP_HOST ?? ''; }
  get smtpPort():          number  { return this.c.SMTP_PORT; }
  get smtpUser():          string  { return this.c.SMTP_USER ?? ''; }
  get smtpPass():          string  { return this.c.SMTP_PASS ?? ''; }
  get isProduction():                   boolean   { return this.c.NODE_ENV === 'production'; }
  get nodeEnv():                        string    { return this.c.NODE_ENV; }
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
  get uploadMaxFileSizeMb():            number    { return this.c.UPLOAD_MAX_FILE_SIZE_MB; }
  get uploadMaxFilesPerRequest():       number    { return this.c.UPLOAD_MAX_FILES_PER_REQUEST; }
  get jsonBodyLimit():                  string    { return this.c.JSON_BODY_LIMIT; }
  get razorpayKeyId():                  string    { return this.c.RAZORPAY_KEY_ID ?? ''; }
  get razorpayKeySecret():              string    { return this.c.RAZORPAY_KEY_SECRET ?? ''; }
  get razorpayWebhookSecret():          string    { return this.c.RAZORPAY_WEBHOOK_SECRET ?? ''; }
  get razorpayConfigured():             boolean   {
    return Boolean(this.c.RAZORPAY_KEY_ID && this.c.RAZORPAY_KEY_SECRET && this.c.RAZORPAY_WEBHOOK_SECRET);
  }
  get cronSubscriptionReconciliation(): string    { return this.c.CRON_SUBSCRIPTION_RECONCILIATION; }
}
