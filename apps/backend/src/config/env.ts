import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV:           z.enum(['development', 'test', 'production']).default('development'),
  PORT:               z.coerce.number().default(3004),
  DATABASE_URL:       z.url(),
  DB_POOL_MAX:        z.coerce.number().default(10),
  JWT_ACCESS_SECRET:  z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  JWT_ACCESS_EXPIRY:  z.string().default('15m'),
  JWT_REFRESH_EXPIRY: z.string().default('7d'),
  REDIS_URL:          z.string().optional(),
  // Sync engine — dedicated root secret for domain-separated key derivation
  // (cursor HMAC, …). Falls back to JWT_ACCESS_SECRET when unset (dev only).
  SYNC_ROOT_SECRET:   z.string().min(32).optional(),
  SMTP_HOST:          z.string().optional(),
  SMTP_PORT:          z.coerce.number().default(587),
  SMTP_USER:          z.string().optional(),
  SMTP_PASS:          z.string().optional(),
  CORS_ORIGINS:       z.string().default('http://localhost:8081,http://localhost:3000'),
  // Auth constants
  OTP_TTL_SECONDS:                  z.coerce.number().default(300),
  OTP_RESEND_COOLDOWN_SECONDS:      z.coerce.number().default(60),
  OTP_MAX_ATTEMPTS:                 z.coerce.number().default(5),
  // Per-IP auth-attempt backstop. Deliberately loose: mobile traffic arrives
  // through carrier-grade NAT, so one IP is thousands of legitimate users —
  // the real abuse limit is per-phone (OTP_MAX_ATTEMPTS). 5/min here locked
  // out entire carrier egress points (flow-critic Phase 2).
  IP_MAX_ATTEMPTS:                  z.coerce.number().default(100),
  DEVICE_CHALLENGE_TTL_SECONDS:     z.coerce.number().default(300),
  SESSION_CACHE_TTL_SECONDS:        z.coerce.number().default(30),
  REFRESH_TOKEN_TTL_SECONDS:        z.coerce.number().default(2592000),
  ACCESS_TOKEN_TTL_SECONDS:         z.coerce.number().default(900),
  SNAPSHOT_CACHE_TTL_SECONDS:       z.coerce.number().default(604800),
  STEP_UP_VALIDITY_SECONDS:         z.coerce.number().default(300),
  STEP_UP_RATE_WINDOW_SECONDS:      z.coerce.number().default(300),
  STEP_UP_MAX_ATTEMPTS:             z.coerce.number().default(5),
  MAX_PASSWORD_LENGTH:              z.coerce.number().default(1024),
  MAX_FAILED_LOGIN_ATTEMPTS:        z.coerce.number().default(5),
  ACCOUNT_LOCKOUT_DURATION_MINUTES: z.coerce.number().default(30),
  MSG91_AUTH_KEY:                   z.string().optional(),
  MSG91_TEMPLATE_ID:                z.string().optional(),
  // Payments (Razorpay). Absent → the app binds the Fake payment provider.
  RAZORPAY_KEY_ID:                  z.string().optional(),
  RAZORPAY_KEY_SECRET:              z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET:          z.string().optional(),
  // File upload limits
  UPLOAD_MAX_FILE_SIZE_MB:          z.coerce.number().default(10),
  UPLOAD_MAX_FILES_PER_REQUEST:     z.coerce.number().default(5),
  JSON_BODY_LIMIT:                  z.string().default('1mb'),
  // Global per-IP request throttle (backstop, not abuse control — see
  // IP_MAX_ATTEMPTS note on carrier-grade NAT).
  THROTTLE_GLOBAL_LIMIT:            z.coerce.number().default(300),
  // loginAttempts is an audit trail, not the enforcement read path (that's
  // Redis) — keep a bounded window of history.
  LOGIN_ATTEMPTS_RETENTION_DAYS:    z.coerce.number().default(30),
  // Cron expressions — configurable without redeploy
  CRON_TOKEN_CLEANUP:               z.string().default('0 3 * * *'),
  CRON_LOGIN_ATTEMPTS_CLEANUP:      z.string().default('30 3 * * *'),
  CRON_DEVICE_AUTO_EXPIRY:          z.string().default('0 3 * * *'),
  CRON_SUBSCRIPTION_RECONCILIATION: z.string().default('*/5 * * * *'),
  CRON_LOW_STOCK_CHECK:             z.string().default('0 8 * * *'),
  CRON_PENDING_ORDER_CLEANUP:       z.string().default('*/30 * * * *'),
});

export type Env = z.infer<typeof envSchema>;

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('[Config] Invalid environment variables:');
  for (const issue of parsed.error.issues) {
    console.error(` - ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

export const env = parsed.data;

// Production must not silently fall back to dev behavior (Fake payments, logged
// OTPs, JWT-secret-derived cursors). Fail fast at boot instead of shipping a
// misconfigured instance.
if (env.NODE_ENV === 'production') {
  const missing: string[] = [];
  if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET || !env.RAZORPAY_WEBHOOK_SECRET)
    missing.push('RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET / RAZORPAY_WEBHOOK_SECRET');
  if (!env.SYNC_ROOT_SECRET) missing.push('SYNC_ROOT_SECRET');
  if (!env.MSG91_AUTH_KEY || !env.MSG91_TEMPLATE_ID)
    missing.push('MSG91_AUTH_KEY / MSG91_TEMPLATE_ID');

  if (missing.length) {
    console.error('[Config] Missing required production configuration:');
    for (const m of missing) console.error(` - ${m}`);
    process.exit(1);
  }
}