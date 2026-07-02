# Ayphen Retail — Backend Architecture PRD

> **Stack:** NestJS · Drizzle ORM · PostgreSQL · Redis · MSG91 · Razorpay
> **App:** Offline-first POS (React Native / Expo mobile + web dashboard)
> **This document:** single authoritative reference for every architectural
> decision, every request flow, every pattern, and every rule that governs the
> backend. Developers read this before writing code. Reviewers reference this
> during code review.

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Project Structure](#2-project-structure)
3. [Environment & Configuration](#3-environment--configuration)
4. [Database](#4-database)
5. [Layered Request / Response Architecture](#5-layered-request--response-architecture)
6. [Cross-Cutting Patterns](#6-cross-cutting-patterns)
7. [Authentication — Mobile Track](#7-authentication--mobile-track)
8. [Authentication — Web Track](#8-authentication--web-track)
9. [Guards & Interceptors](#9-guards--interceptors)
10. [Subscription & Billing Flow](#10-subscription--billing-flow)
11. [Device Management Flow](#11-device-management-flow)
12. [Security](#12-security)
13. [Logging & Observability](#13-logging--observability)
14. [Performance](#14-performance)
15. [Background Jobs & Queues](#15-background-jobs--queues)
16. [API Documentation](#16-api-documentation)
17. [Testing Strategy](#17-testing-strategy)
18. [CI/CD & Deployment](#18-cicd--deployment)
19. [Operational Readiness](#19-operational-readiness)
20. [Error Contracts & Error Codes](#20-error-contracts--error-codes)
21. [Redis Key Reference](#21-redis-key-reference)
22. [Rules at a Glance](#22-rules-at-a-glance)

---

## 1. System Overview

### 1.1 Architecture at a Glance

```
Mobile App (React Native/Expo)        Web Dashboard
       |  Bearer JWT                       |  Cookie Session
       v                                   v
+----------------------------------------------------------+
|                    API LAYER (NestJS)                    |
|                                                          |
|  MobileJwtGuard  -->  StoreGuard  -->  SubStatusGuard   |
|                                                          |
|  Middleware --> Guards --> Interceptors --> Controller   |
|                --> Service --> Repository --> Database   |
|                                                          |
|  EventBus (side effects)  RequestContext (AsyncLocal)   |
+------------------+-----------------------------+--------+
                   |                             |
              PostgreSQL                       Redis
              (Drizzle)                   (cache, queues)
```

### 1.2 Two Auth Tracks

```
Mobile (POS devices)                    Web (Dashboard)
POST /auth/mobile/*                     /auth/web/* (BetterAuth)
MobileJwtGuard                          WebSessionGuard
(Ed25519 JWT + device binding)          (Cookie, DB-backed, 60s cache)
Permission Snapshot (offline-signed)    Step-up OTP for sensitive actions
```

### 1.3 Core Principles

1. **Reads are never blocked.** Only writes are gated by subscription status.
2. **Trial starts at first store creation**, not at signup.
3. **Account name is internal only.** Store name, GST, address go on customer invoices.
4. **Lock, never delete.** Downgrade/expiry makes data read-only; nothing is destroyed.
5. **Offline-first.** Device caches `access_valid_until`; write-gating works with no network.
6. **Dependencies point down and inward.** Controller -> Service -> Repository -> DB. Never reversed.
7. **snake_case at the HTTP boundary.** camelCase everywhere inside.
8. **Security by omission.** Response mappers list fields explicitly — new columns are invisible by default.

---

## 2. Project Structure

```
src/
├── common/
│   ├── decorators/
│   │   ├── current-user.decorator.ts
│   │   └── validators.ts          <- IsValidPrice, IsValidSku, IsIndianPhone, etc.
│   ├── exceptions/
│   │   └── app.exception.ts
│   ├── filters/
│   │   └── all-exceptions.filter.ts
│   ├── interceptors/
│   │   ├── request-context.interceptor.ts
│   │   └── snapshot-refresh.interceptor.ts
│   ├── middleware/
│   │   └── request-id.middleware.ts
│   ├── pagination/
│   │   ├── cursor.ts
│   │   ├── paginate.ts
│   │   └── paginated-response.ts
│   └── validation/
│       └── parse.ts               <- shared Zod parse() helper
├── config/
│   └── env.ts                     <- Zod schema, crash-fast on startup
├── db/
│   ├── db.module.ts               <- Drizzle provider, UnitOfWork, DbExecutor types
│   ├── schema/
│   │   ├── base.ts                <- base columns (NO FK references here)
│   │   ├── users.ts
│   │   ├── devices.ts
│   │   ├── device-sessions.ts
│   │   ├── refresh-tokens.ts
│   │   ├── accounts.ts
│   │   ├── account-users.ts
│   │   ├── account-subscription.ts
│   │   ├── stores.ts
│   │   ├── locations.ts
│   │   ├── store-device-access.ts
│   │   ├── plan-entitlements.ts
│   │   ├── plan-features.ts
│   │   └── index.ts
│   ├── migrations/
│   ├── seeds/
│   └── audit.helpers.ts           <- auditInsert, auditUpdate, auditDelete
├── request-context/
│   └── request-context.service.ts <- AsyncLocalStorage
├── auth/
│   ├── core/                      <- CryptoService, PasswordService, RateLimitService, etc.
│   ├── mobile/
│   │   ├── dto/request/
│   │   ├── dto/response/
│   │   ├── mappers/
│   │   ├── guards/
│   │   │   └── mobile-jwt.guard.ts
│   │   ├── interceptors/
│   │   │   └── snapshot-refresh.interceptor.ts
│   │   ├── services/              <- auth-login, auth-signup, auth-refresh, etc.
│   │   ├── repositories/
│   │   ├── types/
│   │   │   └── mobile-principal.ts
│   │   ├── events/
│   │   └── handlers/
│   ├── web/
│   │   ├── web-session.guard.ts
│   │   └── web-auth.module.ts
│   └── better-auth/
│       └── better-auth.config.ts
├── modules/
│   ├── stores/
│   ├── products/
│   ├── orders/
│   ├── subscription/
│   │   └── guards/
│   │       └── subscription-status.guard.ts
│   └── devices/
├── scheduler/
│   ├── subscription-reconciliation.scheduler.ts
│   ├── device-auto-expiry.scheduler.ts
│   └── token-cleanup.scheduler.ts
├── health/
│   └── health.controller.ts
├── queue/
│   ├── queue.module.ts
│   └── processors/
├── events/
│   ├── event-bus.ts
│   └── domain-event.ts
└── main.ts
```

**Every feature module follows the same internal pattern:**
```
modules/products/
├── dto/
│   ├── request/     <- Zod schemas, snake_case wire format
│   └── response/    <- plain interfaces, snake_case
├── mappers/
│   ├── request/     <- snake_case DTO -> camelCase domain
│   └── response/    <- camelCase domain -> snake_case DTO
├── repositories/    <- Drizzle queries, raw entities only
├── services/        <- business logic, one verb-family each
├── events/
├── handlers/
├── types/           <- domain result types, camelCase
├── products.controller.ts
└── products.module.ts
```

---

## 3. Environment & Configuration

All env vars validated at startup via Zod. Missing or invalid values crash the process before accepting any traffic.

```ts
// src/config/env.ts
export const EnvSchema = z.object({
  NODE_ENV:  z.enum(['development', 'staging', 'production']),
  PORT:      z.coerce.number().default(3000),
  APP_URL:   z.string().url(),
  ALLOWED_ORIGINS: z.string(),

  DATABASE_URL:                  z.string().url(),
  DATABASE_POOL_MIN:             z.coerce.number().default(2),
  DATABASE_POOL_MAX:             z.coerce.number().default(20),
  DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().default(30000),
  DATABASE_IDLE_TIMEOUT_MS:      z.coerce.number().default(10000),

  REDIS_URL:        z.string().url(),
  REDIS_KEY_PREFIX: z.string().default('ayphen:'),

  // Ed25519 asymmetric JWT
  JWT_ED25519_PRIVATE_KEY:      z.string(),
  JWT_ED25519_PUBLIC_KEY:       z.string(),
  JWT_ED25519_PREV_PUBLIC_KEY:  z.string().optional(),  // rotation window
  JWT_ED25519_KEY_ID:           z.string().default('v1'),
  JWT_ACCESS_TTL_SECONDS:       z.coerce.number().default(900),
  JWT_REFRESH_TTL_SECONDS:      z.coerce.number().default(2592000),

  LOGIN_MAX_ATTEMPTS:           z.coerce.number().default(5),
  LOGIN_LOCKOUT_MINUTES:        z.coerce.number().default(15),
  OTP_TTL_SECONDS:              z.coerce.number().default(300),
  OTP_RESEND_COOLDOWN_SECONDS:  z.coerce.number().default(60),
  OTP_MAX_ATTEMPTS:             z.coerce.number().default(5),
  STEP_UP_VALIDITY_SECONDS:     z.coerce.number().default(300),
  STEP_UP_MAX_ATTEMPTS:         z.coerce.number().default(5),
  SNAPSHOT_CACHE_TTL_SECONDS:   z.coerce.number().default(604800),

  TRIAL_DAYS:               z.coerce.number().default(15),
  MSG91_AUTH_KEY:           z.string(),
  MSG91_TEMPLATE_ID:        z.string(),
  RAZORPAY_KEY_ID:          z.string(),
  RAZORPAY_KEY_SECRET:      z.string(),
  RAZORPAY_WEBHOOK_SECRET:  z.string(),
  BETTER_AUTH_SECRET:       z.string(),

  UPLOAD_MAX_FILE_SIZE_MB:  z.coerce.number().default(20),
  UPLOAD_ALLOWED_TYPES:     z.string().default('image/jpeg,image/png,image/webp,application/pdf'),

  // All cron expressions configurable without redeploy
  CRON_SUBSCRIPTION_RECONCILIATION: z.string().default('*/5 * * * *'),
  CRON_DEVICE_AUTO_EXPIRY:          z.string().default('0 3 * * *'),
  CRON_TOKEN_CLEANUP:               z.string().default('0 3 * * *'),
  CRON_LOW_STOCK_CHECK:             z.string().default('0 8 * * *'),
  CRON_PENDING_ORDER_CLEANUP:       z.string().default('*/30 * * * *'),

  ENABLE_SWAGGER: z.coerce.boolean().default(false),
  LOG_LEVEL:      z.string().default('info'),
});

export const env = (() => {
  const result = EnvSchema.safeParse(process.env);
  if (!result.success) {
    console.error('Invalid environment variables:', result.error.flatten().fieldErrors);
    process.exit(1);
  }
  return result.data;
})();
```

---

## 4. Database

### 4.1 Base Columns

`base.ts` exports column shapes ONLY. No FK references (prevents circular imports between schema files).

```ts
// src/db/schema/base.ts
export const baseColumns = {
  id:        uuid('id').primaryKey().defaultRandom(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid('created_by'),   // .references() added per-table
  updatedBy: uuid('updated_by'),   // .references() added per-table
};

export const softDeleteColumns = {
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  deletedBy: uuid('deleted_by'),   // .references() added per-table
};
```

FK references in each table file:

```ts
// src/db/schema/products.ts
export const products = pgTable('products', {
  ...baseColumns,
  ...softDeleteColumns,
  storeFk:   uuid('store_fk').notNull().references(() => stores.id, { onDelete: 'cascade' }),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  deletedBy: uuid('deleted_by').references(() => users.id, { onDelete: 'set null' }),
  name:  text('name').notNull(),
  sku:   text('sku'),
  price: integer('price').notNull(),  // always in paise
});
```

### 4.2 Core Schema

**users**

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | internal |
| guuid | uuid | public-facing |
| phone | text | nullable; phone OR email required |
| email | text | nullable |
| name | text | |
| phoneVerified | boolean | set true on first successful OTP |
| emailVerified | boolean | |
| primaryLoginMethod | enum | otp / password / google |
| permissionsVersion | integer | bumped on any RBAC change |
| status | enum | active / suspended / locked |
| isBlocked | boolean | hard block by admin |
| failedLoginAttempts | integer | reset on success |
| accountLockedUntil | timestamp | temporary lockout after N failures |
| lastLoginAt | timestamp | |
| deletedAt | timestamp | soft delete |

**devices**

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| userFk | uuid -> users | |
| publicKey | text | Ed25519 public key |
| publicKeyHash | text | SHA256(publicKey), indexed |
| platform | enum | ios / android |
| model, osVersion, appVersion | text | |
| attestationVerified | boolean | logged, NOT enforced Phase 1 |
| isTrusted | boolean | admin-set |
| isBlocked | boolean | hard block |
| pushToken | text | stored, not yet sent |
| lastSeenAt, firstSeenAt | timestamp | |

Unique index: (userFk, publicKeyHash)

**device_sessions**

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | sent as device_session_guuid |
| userFk | uuid -> users | |
| deviceFk | uuid -> devices | |
| expiresAt | timestamp | 30-day session |
| lastUsedAt | timestamp | updated on each refresh |
| lastStepUpAt | timestamp | |
| lastStepUpMethod | enum | otp / biometric / totp |
| stepUpLockedUntil | timestamp | |
| revokedAt | timestamp | non-null = revoked |
| currentJti | text | active JWT JTI for blacklisting |

**refresh_tokens**

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | append-only |
| deviceSessionFk | uuid -> device_sessions | |
| tokenHash | text unique | SHA256 of raw token |
| parentId | uuid self-ref | rotation chain |
| familyId | uuid | reuse -> revoke entire family |
| usedAt | timestamp | non-null = rotated; second use = attack |
| expiresAt, revokedAt | timestamp | |

**accounts**

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| accountNumber | text UNIQUE | ACC-A3F2B1 auto-generated |
| name | text | "Raj Kumar's Business" INTERNAL ONLY |
| razorpayCustomerId | text | Ayphen billing of account |

**account_users**

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| accountFk | uuid -> accounts | |
| userFk | uuid -> users | |
| role | enum | owner / co_owner / manager / cashier / accountant |

Unique: (accountFk, userFk)

**account_subscription**

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| accountFk | uuid UNIQUE -> accounts | ONE per account |
| planFk | uuid -> subscription_plan | |
| status | text | trialing / active / past_due / cancelled / paused / free |
| trialEndsAt | timestamp | |
| currentPeriodStart, currentPeriodEnd | timestamp | |
| pastDueGraceUntil | timestamp | 7 days after period end |
| accessValidUntil | timestamp | MAX(period_end, grace_until) |
| cancelAtPeriodEnd | boolean | |
| subscriptionVersion | integer | bumped on every transition |
| hasUsedTrial | boolean | prevents re-trialing |

**stores**

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| accountFk | uuid -> accounts | |
| name | text | ON CUSTOMER INVOICES |
| address | text | ON CUSTOMER INVOICES |
| phone | text | ON CUSTOMER INVOICES |
| email | text | ON CUSTOMER INVOICES |
| gstNumber | text | ON CUSTOMER INVOICES |
| invoicePrefix | text | RF = per-store invoice sequence |
| invoiceCounter | integer | auto-increments per store |
| locked | boolean | true when locked by downgrade |

**locations**

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| storeFk | uuid -> stores | |
| name | text | Head Office / T Nagar Branch |
| isPrimary | boolean | true for Head Office only |
| displayOrder | integer | 0 for Head Office |
| locked | boolean | true when over limit on downgrade |

Head Office: auto-created at store creation. isPrimary=true locations cannot be locked.

**store_device_access**

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| storeFk | uuid -> stores | |
| deviceFk | uuid -> devices | |
| userFk | uuid -> users | |
| status | enum | active / revoked / expired |
| deviceLabel | text | per-store label |
| firstAccessedAt, lastAccessedAt | timestamp | |
| revokedAt, revokedReason | mixed | |

Unique: one active row per (storeFk, deviceFk)

**plan_entitlements** — quantitative limits per plan

```
plan_fk, key, value integer (NULL = unlimited)
Keys: max_stores | max_locations_per_store | max_devices_per_store | max_users_per_store | max_products
UNIQUE (plan_fk, key)
```

**plan_features** — boolean capabilities per plan

```
plan_fk, key, enabled boolean
Keys: gst_invoicing | offline_mode | barcode_scanning | inventory_management |
      multi_location | advanced_reports | loyalty_program | api_access | white_label | priority_support
UNIQUE (plan_fk, key)
```

### 4.3 Connection Pool

```ts
const pool = new Pool({
  connectionString:         env.DATABASE_URL,
  min:                      env.DATABASE_POOL_MIN,
  max:                      env.DATABASE_POOL_MAX,
  idleTimeoutMillis:        env.DATABASE_IDLE_TIMEOUT_MS,
  connectionTimeoutMillis:  5000,
  ssl: env.NODE_ENV === 'production' ? { rejectUnauthorized: true } : false,
});

pool.on('error', (err) => { logger.error('DB pool error', err); process.exit(1); });

// Poll for Prometheus Gauges every 15s (Gauge not Counter -- connections go up AND down)
setInterval(() => {
  dbConnectionsActive.set(pool.totalCount - pool.idleCount);
  dbConnectionsIdle.set(pool.idleCount);
  dbConnectionsWaiting.set(pool.waitingCount);
}, 15_000);

export type Database      = PostgresJsDatabase<typeof schema>;
export type DbTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];
export type DbExecutor    = Database | DbTransaction;

@Injectable()
export class UnitOfWork {
  execute<T>(work: (tx: DbTransaction) => Promise<T>): Promise<T> {
    return this.db.transaction((tx) => work(tx));
  }
}
```

### 4.4 Slow Query Detection

Drizzle's logger only receives query strings — no timing support. Use repository-level wrappers:

```ts
// src/db/query-logger.ts
export function withQueryTiming<T>(label: string, fn: () => Promise<T>, logger: Logger, thresholdMs = 500): Promise<T> {
  const start = performance.now();
  return fn().then(
    (result) => {
      const ms = performance.now() - start;
      if (ms > thresholdMs) logger.warn('Slow query', { label, duration_ms: Math.round(ms) });
      dbQueryDuration.observe({ label }, ms / 1000);
      return result;
    },
    (err) => {
      logger.error('Query failed', { label, duration_ms: Math.round(performance.now() - start), error: err.message });
      throw err;
    },
  );
}

// Usage in every repository
async findByStore(storeId: string): Promise<Product[]> {
  return withQueryTiming('products.findByStore',
    () => this.db.select().from(products).where(eq(products.storeFk, storeId)),
    this.logger);
}
```

### 4.5 Migrations

Migrations run on DEPLOY, never on app start:

```
npm run db:migrate     <- run before starting app
npm run db:seed        <- run once after fresh migrations
npm run db:rollback    <- emergency only
```

### 4.6 Required Indexes

```sql
-- Every FK column
CREATE INDEX idx_stores_account_fk         ON stores(account_fk);
CREATE INDEX idx_account_users_user_fk     ON account_users(user_fk);
CREATE INDEX idx_account_users_account_fk  ON account_users(account_fk);
CREATE INDEX idx_device_sessions_user_fk   ON device_sessions(user_fk);
CREATE INDEX idx_device_sessions_device_fk ON device_sessions(device_fk);
CREATE INDEX idx_refresh_tokens_family_id  ON refresh_tokens(family_id);

-- Soft-delete queries
CREATE INDEX idx_products_store_active ON products(store_fk) WHERE deleted_at IS NULL;
CREATE INDEX idx_orders_store_active   ON orders(store_fk)   WHERE deleted_at IS NULL;

-- Subscription cron queries
CREATE INDEX idx_sub_trialing  ON account_subscription(trial_ends_at)       WHERE status = 'trialing';
CREATE INDEX idx_sub_active    ON account_subscription(current_period_end)   WHERE status = 'active';
CREATE INDEX idx_sub_past_due  ON account_subscription(past_due_grace_until) WHERE status = 'past_due';

-- Active sessions (guard cache miss fallback)
CREATE INDEX idx_sessions_active ON device_sessions(user_fk, expires_at) WHERE revoked_at IS NULL;

-- Orders time-range queries
CREATE INDEX idx_orders_store_time ON orders(store_fk, created_at DESC) WHERE deleted_at IS NULL;
```

---

## 5. Layered Request / Response Architecture

### 5.1 Complete Request Pipeline

```
HTTP Request (snake_case JSON)
  |
  v [Middleware]
  RequestIdMiddleware           <- assign x-request-id header
  IdempotencyMiddleware         <- dedup mutations via Idempotency-Key header
  |
  v [Guards — in order]
  MobileJwtGuard                <- verify JWT, user status, device status
  StoreGuard                    <- tenant isolation (routes with :storeId)
  SubscriptionStatusGuard       <- write-gate (writes only; reads always pass)
  StepUpGuard                   <- when @RequiresStepUp() applied
  |
  v [Interceptors — before handler]
  RequestContextInterceptor     <- set AsyncLocalStorage (AFTER guards, req.user populated)
  |
  v [Pipes]
  ValidationPipe                <- whitelist, forbidNonWhitelisted, transform
  |
  v [Handler]
  Controller                    <- parse(body, Zod), map to domain, call service, map result
  Service                       <- business logic, UoW for writes, EventBus for side effects
  Repository                    <- Drizzle queries, raw entities
  Database (PostgreSQL)
  |
  v (entities flow back up)
  Response Mapper               <- domain result -> snake_case DTO, strips secrets
  |
  v [Interceptors — after handler]
  SnapshotRefreshInterceptor    <- append X-Permissions-Version header
  |
  v
  HTTP Response (snake_case JSON)
```

### 5.2 Dependency Direction

```
Controller    -> Request Schema, Request Mapper, Service, Response Mapper
Request Mapper -> Domain types only
Response Mapper -> Domain types, Response DTO
Service        -> Repository, other Services, EventBus, UoW
Repository     -> Drizzle schema only
Response DTO   -> nothing (leaf node)
Request Schema -> Zod only (leaf node)
```

A lower layer NEVER imports an upper layer.

### 5.3 Request Schema (Zod)

```ts
// Shared parse() helper — used by every controller
export function parse<T>(body: unknown, schema: ZodType<T>): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new UnprocessableEntityException(result.error.issues);
  return result.data;
}

// Cross-field validation via superRefine
export const StepUpVerifyDtoSchema = z.object({
  method:         z.enum(['otp_sms', 'biometric', 'totp', 'password_reentry']),
  credential:     z.string().min(1),
  otp_request_id: z.string().uuid().optional(),
  challenge_id:   z.string().uuid().optional(),
}).superRefine((v, ctx) => {
  if (v.method === 'otp_sms' && !v.otp_request_id) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'otp_request_id required', path: ['otp_request_id'] });
  }
});
```

### 5.4 Controller

Thin. Parse -> Map -> Service -> Map out. No business logic.

```ts
@Controller('stores/:storeId/products')
@UseGuards(MobileJwtGuard, StoreGuard, SubscriptionStatusGuard)
export class ProductsController {
  @Post()
  @HttpCode(201)
  async create(@Body() body: unknown, @CurrentUser() actor: MobilePrincipal): Promise<CreateProductResponse> {
    const dto    = parse(body, CreateProductDtoSchema);
    const cmd    = ProductRequestMapper.toCreateCommand(dto);
    const result = await this.createService.create(cmd);
    return ProductResponseMapper.toCreateResponse(result);
  }
}
```

### 5.5 Service

Orchestrates, applies business rules, uses UoW for writes, emits events for side effects.

```ts
@Injectable()
export class ProductCreateService {
  async create(cmd: CreateProductCommand): Promise<ProductResult> {
    const storeId = this.ctx.getStoreId()!;

    // Pre-transaction: read-only validation
    await this.checkProductLimit(storeId);

    // Transactional: all writes together
    const product = await this.uow.execute(async (tx) => {
      return this.repo.create({ ...cmd, storeFk: storeId, ...auditInsert(this.ctx) }, tx);
    });

    // Post-transaction: side effects via EventBus
    this.events.publish({ type: 'product.created', aggregateId: product.id, payload: { productId: product.id, storeId } });

    return product;
  }
}
```

Transaction rules:

| Operation | Inside tx? |
|---|---|
| DB writes (same or different aggregates) | YES |
| DB reads (pre-validation) | Before tx |
| JWT signing | NO - after tx |
| External API calls (Razorpay, MSG91) | NO - after tx |
| Push / email / audit | NO - via events after tx |

### 5.6 Repository

Only layer that touches the database. Returns raw Drizzle entities. All write methods accept optional `tx?: DbExecutor`.

```ts
@Injectable()
export class ProductRepository {
  async create(data: CreateProductInput, tx?: DbExecutor): Promise<Product> {
    return withQueryTiming('products.create', async () => {
      const [row] = await (tx ?? this.db).insert(products).values(data).returning();
      return row!;
    }, this.logger);
  }

  async softDelete(id: string, tx?: DbExecutor): Promise<void> {
    await (tx ?? this.db).update(products).set(auditDelete(this.ctx)).where(eq(products.id, id));
  }
}
```

### 5.7 Response Mapper

Pure function. camelCase domain -> snake_case DTO. Lists fields explicitly. Never spread.

```ts
export const ProductResponseMapper = {
  toProductResponse(p: Product): ProductResponse {
    return {
      id:         p.id,
      name:       p.name,
      sku:        p.sku ?? null,
      price:      p.price,
      created_at: p.createdAt.toISOString(),
      // costPrice, createdBy intentionally NOT exposed
    };
  },
};
```

---

## 6. Cross-Cutting Patterns

### 6.1 RequestContextService (AsyncLocalStorage)

Set inside `RequestContextInterceptor` AFTER guards run (req.user is populated). NOT in middleware.

```ts
const storage = new AsyncLocalStorage<RequestContext>();

@Injectable()
export class RequestContextService {
  static run(ctx: RequestContext, fn: () => unknown): unknown { return storage.run(ctx, fn); }
  getUserId():    string | undefined { return storage.getStore()?.user?.userId; }
  getAccountId(): string | undefined { return storage.getStore()?.accountId; }
  getStoreId():   string | undefined { return storage.getStore()?.storeId; }
  getRequestId(): string | undefined { return storage.getStore()?.requestId; }
  getIp():        string | undefined { return storage.getStore()?.ip; }
}

// RequestContextInterceptor — set context here, not in middleware
@Injectable()
export class RequestContextInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest();
    const user    = request.user as MobilePrincipal | undefined;
    if (!user) return next.handle();

    return new Observable((observer) => {
      RequestContextService.run(
        { user, requestId: request.headers['x-request-id'] ?? '', ip: request.ip ?? '',
          userAgent: request.headers['user-agent'] ?? '',
          storeId: request.storeContext?.storeId, accountId: request.storeContext?.accountId },
        () => { next.handle().subscribe({ next: v => observer.next(v), error: e => observer.error(e), complete: () => observer.complete() }); },
      );
    });
  }
}
```

When to use context vs explicit parameter:

| Use ctx.getUserId() | Pass explicitly |
|---|---|
| Audit stamps (createdBy, updatedBy) | transferOwnership(storeId, targetUserId, actorUserId) |
| Logging (requestId, ip, userAgent) | cancelSubscription(accountId, reason) |
| Non-sensitive reads | Any sensitive flow where actor identity changes meaning |

### 6.2 Audit Helpers

```ts
// src/db/audit.helpers.ts
export function auditInsert(ctx: RequestContextService, fallbackUserId?: string) {
  const userId = ctx.getUserId() ?? fallbackUserId ?? null;
  const now    = new Date();
  return { createdBy: userId, updatedBy: userId, createdAt: now, updatedAt: now };
}
export function auditUpdate(ctx: RequestContextService, fallbackUserId?: string) {
  return { updatedBy: ctx.getUserId() ?? fallbackUserId ?? null, updatedAt: new Date() };
}
export function auditDelete(ctx: RequestContextService, fallbackUserId?: string) {
  const userId = ctx.getUserId() ?? fallbackUserId ?? null;
  const now    = new Date();
  return { deletedBy: userId, deletedAt: now, updatedBy: userId, updatedAt: now };
}
```

Audit param is OPTIONAL so cron jobs and seeds can call the same repo methods without context.

### 6.3 Unit of Work

```ts
// Any service writing to >= 2 repos
const result = await this.uow.execute(async (tx) => {
  const a = await this.repoA.create(dataA, tx);
  const b = await this.repoB.create(dataB, tx);
  return { a, b };
});
// Either both commit or both roll back
```

### 6.4 Domain Events

Side effects never go into services directly. Services emit; handlers listen independently.

```ts
// Service emits
this.events.publish({ type: 'auth.user.logged_in', aggregateId: user.id,
  payload: { userId: user.id, deviceId, sessionId, ip, isNewDevice } });

// Handler 1 — audit
@EventHandler('auth.user.logged_in')
export class LogLoginAuditHandler {
  async handle(event): Promise<void> { await this.auditService.log({ event: 'AUTH_LOGIN', ...event.payload }); }
}

// Handler 2 — push notification
@EventHandler('auth.user.logged_in')
export class SendNewDeviceNotificationHandler {
  async handle(event): Promise<void> {
    if (!event.payload.isNewDevice) return;
    await this.pushQueue.add('send', { userId: event.payload.userId, title: 'New device login' });
  }
}
```

Rule: if side effect failure should NOT roll back main flow -> use event. If it MUST be atomic -> direct call inside tx.

### 6.5 Idempotency

All mutation endpoints support `Idempotency-Key` header. Same key within 24h returns cached response.

### 6.6 Cursor Pagination

All list endpoints use cursor-based pagination. Offset only for admin tables needing random access.

```ts
export interface CursorPage<T> {
  data:        T[];
  next_cursor: string | null;
  has_more:    boolean;
  count:       number;
}
// Limit capped at 100 per request
// next_cursor is opaque base64url encoded { id, v: sortValue }
```

---

## 7. Authentication — Mobile Track

### 7.1 OTP Login / Signup (Two Stages)

**Stage 1 — Request OTP** (`POST /auth/mobile/login` with no otp_code):

```
1. RateLimitService.checkIpLimit()         (5/min per IP)
2. RateLimitService.checkPhoneOtpLimit()   (5 requests/5min per phone)
3. OtpRequestRepository.insertOtpRequest()
4. OtpService.sendOtp()
   [prod] Msg91Service.sendOtp()
   [dev]  Redis.set("dev_otp:{phone}", code, OTP_TTL)
5. Response: { otp_sent: true, expires_in: 300, otp_request_id: uuid }
```

**Stage 2 — Verify OTP + Issue Tokens:**

```
Body: { method: 'otp', phone, otp_code, otp_request_id,
        device: { publicKey, platform, model, osVersion, appVersion, pushToken } }

Pre-transaction (read-only):
  1. RateLimitService.checkIpLimit()
  2. OtpService.verifyOtp(phone, code, requestId)
       findActiveRequest() -- check expiry + attempts
       timingSafeEqual(stored, submitted)
       markConsumed()
  3. UserRepository.findByPhone()
     LOGIN:  must exist -> else USER_NOT_FOUND
     SIGNUP: must NOT exist -> else USER_ALREADY_EXISTS

Transactional:
  4. [SIGNUP] insertUser() + persistDpdpConsent() + incrementPermissionsVersion()
     [LOGIN]  markPhoneVerified(true) + resetFailedAttempts()
  5. DeviceService.upsertDevice()
       SHA256(publicKey) -> publicKeyHash
       (userFk, publicKeyHash) exists -> update; else insert
       attestation: verified flag set but NOT enforced in Phase 1
  6. AuthSessionRepository.createSession()
  7. RefreshTokenService.issueRefreshToken()
       crypto.randomBytes(48) -> SHA256 -> insert refresh_tokens row

Post-transaction:
  8. CryptoService.signJwt({ sub: userId, jti: uuid, deviceSessionId, type: 'access' })
  9. EventBus.publish(auth.user.logged_in) -> audit, push notification handlers
  10. Response: { access_token, refresh_token, user: { id, permissions_version },
                  is_new_user, device_guuid, device_session_guuid, is_trusted }
```

### 7.2 Token Refresh

```
POST /auth/mobile/refresh
Body: { refresh_token, challenge_id?, device_signature?, idempotency_key, snapshot_version? }

1. RefreshIdempotencyService (Redis 60s):
     HIT done    -> return cached response
     HIT pending -> poll up to 3s
     MISS        -> claim (SETNX pending), proceed

2. RefreshTokenRepository.findByHash(SHA256(token)) + joins

3. Precondition checks:
   token expired?      -> REFRESH_TOKEN_EXPIRED
   usedAt not null?    -> revokeFamily(familyId) -> REFRESH_TOKEN_REUSE
   token revoked?      -> REFRESH_TOKEN_REVOKED
   session revoked?    -> SESSION_REVOKED
   session expired?    -> SESSION_EXPIRED
   user deleted?       -> USER_NOT_FOUND
   user not active?    -> USER_SUSPENDED

4. Device signature check:
   consumeChallenge(challengeId) -- Redis DEL (single-use)
   verifyDeviceSignature(publicKey, challenge, signature)

5. Atomic DB transaction:
   markTokenUsed(old)
   insert new token (parentId = old.id, same familyId)
   update session.lastUsedAt

6. Blacklist old JTI:
   Redis SETEX "jti:{jti}", TTL
   RevokedTokenRepository.insert(jti, exp)

7. Issue new JWT

8. SnapshotService.getOrBuild(userId):
   Redis HIT + version matches -> return null (no transfer needed)
   MISS -> build -> Ed25519 sign -> Redis SET 7d

9. Response: { access_token, refresh_token,
               snapshot | null, snapshot_signature, snapshot_changed }
```

### 7.3 MobileJwtGuard Pipeline

```
1. Extract Bearer token

2. CryptoService.verifyJwt(token)
     Try current Ed25519 public key
     On failure, try JWT_ED25519_PREV_PUBLIC_KEY (rotation window)
     Returns: { sub, jti, deviceSessionId, type, iat, exp }

3. payload.type !== 'access' -> TOKEN_INVALID

4. JTI blacklist (3-layer):
     In-process LRU (10k entries) -> HIT -> UNAUTHORIZED
     Redis "jti:{jti}"            -> HIT -> UNAUTHORIZED; backfill LRU
     DB RevokedTokens             -> HIT -> UNAUTHORIZED; backfill Redis+LRU

5. Replay protection:
     X-Timestamp: |request.ts - server.now| > 30s -> REPLAY_DETECTED
     X-Nonce: Redis SETNX "nonce:{deviceId}:{nonce}", 10min -> exists -> REPLAY_DETECTED

6. Session validation (Redis 30s cache -> DB fallback):
     not found   -> UNAUTHORIZED
     revoked     -> SESSION_REVOKED
     expired     -> SESSION_EXPIRED
     device blocked -> DEVICE_BLOCKED

7. User status checks (in order):
     user.deletedAt         -> USER_NOT_FOUND
     user.isBlocked         -> USER_BLOCKED
     user.status=suspended  -> USER_SUSPENDED
     user.status=locked     -> USER_LOCKED
     user.accountLockedUntil > now -> USER_LOCKED
     !user.phoneVerified    -> PHONE_NOT_VERIFIED

8. req.user = MobilePrincipal { userId, userGuuid, deviceSessionId, deviceId,
                                  devicePlatform, permissionsVersion, stepUpAt, stepUpMethod }
```

### 7.4 Step-Up Authentication

Required before: billing actions, ownership transfer, subscription cancel, staff role changes.

```
POST /auth/mobile/step-up
Body: { method, credential, otp_request_id?, challenge_id? }
Requires: valid JWT

1. Rate limit: Redis count + DB stepUpLockedUntil
2. Method verification:
   otp_sms:          OtpService.verifyOtp()
   biometric:        consumeChallenge() + verifyDeviceSignature()
   totp:             TotpService.verify()
   password_reentry: PasswordService.verify()
3. On failure: Redis INCR; >= MAX -> setStepUpLockedUntil()
4. On success: Redis DEL; updateStepUp(sessionId, method, now)
5. Response: { ok: true, valid_until }

Guard check in sensitive routes:
  const age = Date.now() - session.lastStepUpAt.getTime();
  if (age > STEP_UP_VALIDITY_SECONDS * 1000) throw StepUpRequiredException()
```

### 7.5 Permission Snapshot

Offline-capable, Ed25519-signed payload. Delivered via refresh response or background header.

Snapshot contains: userId, permissionsVersion, stores (with roles, permissions, offlineConstraints).
Subscription data is NOT in the snapshot. It has its own channel.

```
Build flow:
  Redis HIT + version matches -> return cached (skip rebuild)
  MISS ->
    getUserBaseData() + getUserStoreAccess() (batched, no N+1)
    For each store: getRoleAssignments + getCrudPermissions + getSpecialPermissions
    Build canonical JSON (sorted keys, deterministic)
    Ed25519 sign
    Redis SET 7d TTL

Invalidation: any RBAC change -> permissionsVersion++ -> Redis DEL "snapshot:{userId}"
```

### 7.6 Logout

```
POST /auth/mobile/logout
  Blacklist currentJti (Redis + DB)
  Revoke device session (DB + Redis cache invalidate)
  Audit log via EventBus

POST /auth/mobile/logout/all
  Revoke all non-expired sessions for user
  Blacklist all active JTIs
  Invalidate all session cache keys
```

---

## 8. Authentication — Web Track

### 8.1 BetterAuth Session

```ts
// better-auth.config.ts
session: {
  cookieCache:  { enabled: true, maxAge: 60 },  // 60s cache - reduces DB hits
  expiresIn:    7 * 24 * 60 * 60,               // 7 days
  updateAge:    24 * 60 * 60,                   // rolling expiry
},
advanced: {
  cookiePrefix: 'ba',
  cookieOptions: { sameSite: 'strict', secure: true, httpOnly: true },
},
```

### 8.2 WebSessionGuard

```
1. betterAuth.api.getSession(req)
2. UserRevocationCacheService.isDeleted(userId) -- 5s cache
3. user.status check: suspended -> USER_SUSPENDED, locked -> USER_LOCKED
4. user.accountLockedUntil check
5. !user.emailVerified -> EMAIL_NOT_VERIFIED
6. req.session = { userId, sessionId, stepUp? }
```

### 8.3 Web Step-Up

```
POST /auth/web/step-up
Body: { method: 'otp_sms', credential, otp_request_id }
Same OTP verification as mobile.
WebSessionStepUpRepository.upsert(sessionId, userId, method, now)
```

---

## 9. Guards & Interceptors

### 9.1 StoreGuard — Tenant Isolation (P0 Security)

Without this, any authenticated user can call any store's API.

```ts
@Injectable()
export class StoreGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const storeId = request.params?.storeId;
    if (!storeId) return true;

    const store = await this.storeRepo.findById(storeId);
    if (!store || store.deletedAt) throw new NotFoundException(ErrorCodes.STORE_NOT_FOUND);

    const membership = await this.accountUserRepo.findMembership(
      request.user.userId, store.accountFk
    );
    if (!membership) throw new ForbiddenException(ErrorCodes.STORE_ACCESS_DENIED);

    request.storeContext = { storeId: store.id, accountId: store.accountFk,
                              role: membership.role, isLocked: store.locked ?? false };
    return true;
  }
}
```

### 9.2 SubscriptionStatusGuard — Write Gate

```ts
@Injectable()
export class SubscriptionStatusGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return true; // reads never blocked

    const sub = await this.subRepo.findByAccountId(request.storeContext?.accountId);
    if (!sub) return true;

    if (sub.status === 'paused') throw new ForbiddenException({ code: 'subscription_suspended' });
    if (sub.accessValidUntil && new Date() >= sub.accessValidUntil)
      throw new HttpException({ code: 'subscription_payment_required' }, 402);

    const response = context.switchToHttp().getResponse();
    response.setHeader('X-Subscription-Version', sub.subscriptionVersion);
    if (sub.status === 'past_due' && sub.pastDueGraceUntil)
      response.setHeader('X-Subscription-Warning', `past_due:grace_until_${sub.pastDueGraceUntil.toISOString()}`);

    return true;
  }
}
```

### 9.3 Execution Order

```
Middleware -> Guards -> Interceptors -> Pipes -> Handler -> Interceptors (response)

MobileJwtGuard (req.user set)
  -> StoreGuard (req.storeContext set)
     -> SubscriptionStatusGuard
        -> RequestContextInterceptor (reads req.user SAFELY here)
           -> Controller -> Service -> Repository -> DB
              -> SnapshotRefreshInterceptor (appends X-Permissions-Version)
```

---

## 10. Subscription & Billing Flow

### 10.1 First Store Creation — Atomic Transaction

Account and subscription are created at first store creation, NOT at signup.

```
POST /stores { name, address, phone, gst_number, invoice_prefix }

ATOMIC TRANSACTION:
1. accounts INSERT: { id, accountNumber: 'ACC-XXXXXX', name: user.name + "'s Business" }
   (account name is INTERNAL ONLY — never on customer invoices)
2. account_users INSERT: { accountFk, userFk, role: 'owner' }
3. account_subscription INSERT: {
     accountFk, planFk: FREE_TRIAL_PLAN_ID, status: 'trialing',
     trialEndsAt: NOW() + TRIAL_DAYS, accessValidUntil: trialEndsAt,
     hasUsedTrial: true, subscriptionVersion: 1
   }
4. stores INSERT: {
     accountFk, name, address, phone, gstNumber,  <- these go on customer invoices
     invoicePrefix, invoiceCounter: 0, locked: false
   }
5. locations INSERT: {
     storeFk, name: 'Head Office', isPrimary: true,
     displayOrder: 0, locked: false
   }
   (Head Office = slot 1 of max_locations_per_store, immune to locking forever)
COMMIT
```

Subsequent stores: check `activeStoreCount < max_stores`, then create store + Head Office only.

### 10.2 Plan Limit Enforcement

Entitlements always resolved from: `stores.accountFk -> account_subscription -> plan_entitlements(key)`

```
POST /stores                    -> check max_stores (account-level)
POST /stores/:id/locations      -> check max_locations_per_store (per-store, inclusive of HQ)
POST /stores/:id/access         -> check max_devices_per_store (per-store)
POST /stores/:id/invitations    -> check max_users_per_store (per-store)
POST /stores/:id/products       -> check max_products (per-store)
```

Entitlement check: `value = NULL -> unlimited; count >= value -> 403 {LIMIT}_REACHED`

### 10.3 Razorpay Upgrade Flow

```
1. GET /subscription/plans (cached 24h)
2. User picks plan -> step-up OTP (owner/co_owner/accountant only)
3. POST /me/account/subscription/checkout { plan_code }
     Create Razorpay order
     prefill.name = user.name (NOT account label)
     prefill.contact = user.phone
     Response: { razorpay_key, order_id, amount, prefill }
4. Client launches Razorpay SDK
5. POST /me/account/subscription/verify { razorpay_payment_id, order_id, signature }
     Verify HMAC-SHA256 signature
     activateFromPayment():
       status = 'active', current_period_end = NOW() + days
       access_valid_until = current_period_end, subscriptionVersion++
6. Client detects X-Subscription-Version changed
     GET /me/subscription -> refresh state -> banner clears
```

### 10.4 Subscription State Machine

```
[Signup] -> [Profile] -> [First Store Created]
                                |
                           trialing (15 days from store creation)
                                |
              +-----------------+------------------+
              |                 |                  |
            pays         trial ends,         picks free plan
              |           no payment              |
              v                |                  v
           active          cancelled            free
              |
        +-----+-----+
        |           |
     cancels    payment fails
        |           |
        v           v
   cancelled    past_due (7-day grace)
        |           |
   period end   grace ends
        |           |
   write-blocked   write-blocked (402)
   reads OK        reads OK
   Nothing deleted  Nothing deleted

admin suspend -> paused (403, reads OK)
```

All transitions are account-level and apply to all stores simultaneously.

### 10.5 Reconciliation Cron (Every 5 Minutes)

```ts
// Overlap prevention
if (this.isRunning) return;
this.isRunning = true;
try {
  // trialing -> cancelled
  UPDATE account_subscription
    SET status='cancelled', subscription_version = subscription_version + 1
    WHERE status='trialing' AND trial_ends_at < NOW();

  // active -> past_due
  UPDATE account_subscription
    SET status='past_due',
        past_due_grace_until = current_period_end + INTERVAL '7 days',
        access_valid_until   = current_period_end + INTERVAL '7 days',
        subscription_version = subscription_version + 1
    WHERE status='active' AND current_period_end < NOW();
} finally {
  this.isRunning = false;
}
```

### 10.6 Offline Write-Gating

Device caches: `{ status, access_valid_until, server_time_offset_ms }`

Client side (every write attempt):
```
now = Date.now() + server_time_offset_ms
canWrite:
  status in (active, trialing, free)  -> ALLOW
  now < access_valid_until            -> ALLOW (in grace window)
  else                                -> BLOCK locally
```

Server side (POST /sync/delta):
```
if mutation.client_modified_at <= account.access_valid_until + CLOCK_SKEW:
  ACCEPT  (sale was before lapse)
else:
  REJECT 'SUBSCRIPTION_LAPSED_AT_WRITE'
```

Result: no legitimate sale is ever lost; a lapsed account cannot sell indefinitely offline.

### 10.7 Downgrade Rules

| Resource | On Downgrade | Recovery |
|---|---|---|
| Stores over max_stores | store.locked = true, read-only | Auto-unlock on upgrade |
| Locations over limit | location.locked = true, read-only | Auto-unlock on upgrade |
| Head Office | IMMUNE — never locked (isPrimary=true) | N/A |
| Devices over limit | Existing keep working; new blocked | Auto-expire in 30 days |
| Staff over limit | Existing keep access; new invites blocked | Owner removes members |
| Products over limit | Existing kept; new creates blocked | Owner archives |

Owner always chooses which stores to keep on downgrade. System never auto-picks.

---

## 11. Device Management Flow

### 11.1 Registration (Invisible, at Login)

No separate /devices/register endpoint. Part of login stage 2.

```
First install: app generates Ed25519 key pair
  private key -> Keychain / Android Keystore (never leaves device)
  public key  -> sent in login body

DeviceService.upsertDevice():
  SHA256(publicKey) -> publicKeyHash
  (userFk, publicKeyHash) exists -> update lastSeenAt, appVersion, pushToken
                                  -> return existing device
  else -> insert new device row
  attestation: set flag, NOT blocking in Phase 1
```

### 11.2 Store Slot Claim

```
POST /stores/:storeId/access (empty body, device from JWT context)

1. Resolve limit: stores.accountFk -> account_subscription -> plan_entitlements(max_devices_per_store)
   (NEVER from store_subscription)
2. Active store_device_access for (store, device) exists?
     YES -> update last_accessed_at -> { access: 'granted', isNew: false }
     NO  -> count active for store:
       count < maxDevices -> INSERT store_device_access -> { granted, isNew: true }
       count >= maxDevices -> 403 DEVICE_LIMIT_REACHED { limit, active, devices: [...] }
3. Atomicity: count + insert in transaction + unique index on (store, device, status='active')

When slot claim runs:
  Launch -> auto-nav to single store  YES
  Tap store on picker                 YES
  Switch stores                       YES
  Return from background (session live) NO
  Offline                             NO (uses cached access)
```

### 11.3 Device Auto-Expiry (Daily Cron)

```sql
UPDATE store_device_access
SET status = 'expired', revoked_at = NOW(), revoked_reason = 'auto_expired'
WHERE status = 'active' AND last_accessed_at < NOW() - INTERVAL '30 days';
```

### 11.4 Block Stolen Device

```
PATCH /devices/:id/block
  device.is_blocked = true
  Revoke ALL device_sessions for this device (across all stores)
  Blacklist all active JTIs for those sessions
  Next API call from device -> DEVICE_BLOCKED
  (push notification not wired in Phase 1 -- device learns on next API call)
```

### 11.5 Remove from Store

```
POST /stores/:storeId/devices/:deviceId/revoke { reason: 'owner_removed' }
  store_device_access.status = 'revoked'
  Revoke device_sessions for (device + user) tied to this store
  Audit log
  Cannot remove your own current device (self-lockout prevention)
  Device learns on next API call -> DEVICE_REVOKED
```

---

## 12. Security

### 12.1 main.ts Setup

```ts
app.use(helmet({ hsts: { maxAge: 31536000, includeSubDomains: true }, frameguard: { action: 'deny' } }));
app.use(compression({ threshold: 1024 }));
app.enableCors({ origin: allowlistCheck, credentials: true });
app.useBodyParser('json',       { limit: '10mb' });
app.useBodyParser('urlencoded', { limit: '10mb', extended: true });
app.set('trust proxy', 1);          // correct IP behind load balancer
app.disable('x-powered-by');        // don't leak tech stack

// 30 second hard timeout
app.use((req, res, next) => { req.setTimeout(30000, () => res.status(408).json(...)); next(); });

// Global pipes
app.useGlobalPipes(new ValidationPipe({
  whitelist: true, forbidNonWhitelisted: true, transform: true, stopAtFirstError: false
}));

// Global filter -- single source of HTTP error translation
app.useGlobalFilters(new AllExceptionsFilter(logger));

// Global interceptors (order matters)
app.useGlobalInterceptors(new RequestContextInterceptor(), new SnapshotRefreshInterceptor());

app.enableShutdownHooks();
```

### 12.2 Rate Limiting

| Scope | Limit | Window |
|---|---|---|
| IP (login) | 5 attempts | 1 minute |
| Phone OTP | 5 requests | 5 minutes |
| Account (failed login) | 10 failures | 1 hour |
| Step-up | 5 attempts | configurable |
| POST /auth general | 20 req | 1 minute |
| All other routes | 100 req | 1 minute |

### 12.3 Account Lockout

After LOGIN_MAX_ATTEMPTS (default 5) OTP failures:
  failedLoginAttempts++ on each failure
  On Nth failure: accountLockedUntil = NOW() + LOGIN_LOCKOUT_MINUTES
  MobileJwtGuard checks accountLockedUntil on every request
  Reset to 0 + null on successful login

### 12.4 JWT Key Rotation (Zero-Downtime)

```
Step 1: Generate new Ed25519 key pair
Step 2: Deploy with:
  JWT_ED25519_PRIVATE_KEY      = new private key
  JWT_ED25519_PUBLIC_KEY       = new public key
  JWT_ED25519_PREV_PUBLIC_KEY  = old public key  <- keep for rotation window
  JWT_ED25519_KEY_ID           = 'v2'
Step 3: Deploy
  New tokens: signed with new key
  Old tokens (max 15 min): verified with prev public key
Step 4: After 15 min, unset JWT_ED25519_PREV_PUBLIC_KEY
```

### 12.5 Input Validation

Global ValidationPipe with `whitelist: true` strips unknown fields.
Sanitize-html used ONLY on specific rich-text fields (e.g., product description).
NO global regex sanitizer pipe (unreliable, false confidence).

### 12.6 Secrets Never Logged

pino redact config covers: `req.headers.authorization`, `req.body.password`, `req.body.otp`, `req.body.refresh_token`.

---

## 13. Logging & Observability

### 13.1 Structured Logging (pino)

```ts
const pinoLogger = pino({
  level:  env.LOG_LEVEL,
  redact: { paths: ['req.headers.authorization', 'req.body.password', 'req.body.otp'], censor: '[REDACTED]' },
  formatters: { level: (label) => ({ level: label }) },
  timestamp: pino.stdTimeFunctions.isoTime,
  transport: env.NODE_ENV === 'development' ? { target: 'pino-pretty', options: { colorize: true } } : undefined,
});
```

Every log entry must include: `timestamp`, `level`, `message`, `context`, `traceId`, `userId`, `storeId`, `accountId`, `ip`, `duration_ms`.

### 13.2 Health Endpoints

```
GET /health         -- all checks (db, redis, memory)
GET /health/live    -- K8s liveness probe -- process is alive
GET /health/ready   -- K8s readiness probe -- db + redis up
GET /health/crons   -- last run stats for each cron
```

DB check: `this.db.execute(sql'SELECT 1')` via Drizzle directly (NOT TypeORM).
Redis check: `this.redis.ping()`.

### 13.3 Prometheus Metrics

```
httpRequestDuration  Histogram  method, route, status_code
httpRequestTotal     Counter    method, route, status_code

dbConnectionsActive  Gauge      (NOT Counter -- goes up AND down)
dbConnectionsIdle    Gauge
dbConnectionsWaiting Gauge

dbQueryDuration      Histogram  label

subscriptionTransitions  Counter  from_status, to_status
otpAttempts              Counter  outcome (success|failed|expired)
```

Pool stats polled every 15s. Exposed at `GET /metrics` (internal only, not public).

---

## 14. Performance

### 14.1 Response Caching

Use named TTL helpers to avoid cache-manager v4 vs v5 unit confusion:

```ts
export const CachedForSeconds = (s: number) => CacheTTL(isCacheV5() ? s * 1000 : s);
export const CachedForMinutes = (m: number) => CachedForSeconds(m * 60);
export const CachedForHours   = (h: number) => CachedForSeconds(h * 3600);

@Get('subscription/plans')
@CachedForHours(24)     // plan catalog rarely changes
async getPlans() { ... }
```

### 14.2 All Monetary Values

Always stored in **paise** (integer). Never floating point.

---

## 15. Background Jobs & Queues

### 15.1 Bull Queues

```ts
BullModule.registerQueue(
  { name: 'email' },
  { name: 'sms' },
  { name: 'push-notification' },
  { name: 'sync' },
  { name: 'reports' },
)
defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 5000 } }
```

### 15.2 Cron Registration

@Cron() decorator cannot read config at class definition time. Use SchedulerRegistry + CronJob:

```ts
@Injectable()
export class SubscriptionReconciliationScheduler implements OnModuleInit {
  private isRunning = false;
  private stats = { lastRunAt: null, lastDurationMs: 0, transitions: 0, error: null };

  onModuleInit() {
    const job = new CronJob(this.config.get('CRON_SUBSCRIPTION_RECONCILIATION'), async () => {
      if (this.isRunning) return;
      this.isRunning = true;
      const start = Date.now();
      try {
        const transitions = await this.service.reconcile();
        this.stats = { lastRunAt: new Date(), lastDurationMs: Date.now() - start, transitions, error: null };
      } catch (err) {
        this.stats.error = (err as Error).message;
      } finally {
        this.isRunning = false;
      }
    });
    this.schedulerRegistry.addCronJob('subscription-reconciliation', job);
    job.start();
  }

  getLastRunStats() { return this.stats; }
}
```

Same pattern for: device-auto-expiry, token-cleanup, low-stock-check, pending-order-cleanup.

---

## 16. API Documentation

```ts
// Swagger DISABLED in production (ENABLE_SWAGGER=false)
if (env.ENABLE_SWAGGER) {
  const config = new DocumentBuilder()
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'mobile-jwt')
    .addCookieAuth('ba-session-token', { type: 'apiKey', in: 'cookie' }, 'web-session')
    .build();
  SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, config));
}
```

---

## 17. Testing Strategy

Three layers:

```
Unit         -- mappers, validators, pure services (no DB, no Redis, no HTTP)
Integration  -- service + real test DB (Postgres in Docker)
E2E          -- full HTTP + real DB + real Redis
```

Coverage targets:

| Layer | Target |
|---|---|
| Mappers (pure) | 100% |
| Validators | 100% of branches |
| Services | 85%+ including failure paths |
| Repositories | 80%+ via integration tests |
| E2E | Critical happy path + 1 failure path per endpoint |

Example integration test that validates UoW:
```ts
it('rolls back all writes if refreshToken insert fails', async () => {
  mockTokenService.issueRefreshToken.mockRejectedValue(new Error('boom'));
  await expect(service.loginStageTwo(cmd)).rejects.toThrow();
  const sessions = await db.select().from(deviceSessions);
  expect(sessions).toHaveLength(0); // both inserts rolled back
});
```

---

## 18. CI/CD & Deployment

### 18.1 CI Pipeline

```yaml
jobs:
  test:
    services:
      postgres: { image: postgres:15 }
      redis:    { image: redis:7 }
    steps:
      - npm ci
      - npm run type-check
      - npm run lint
      - npm run test:unit
      - npm run db:migrate      # migrations BEFORE app
      - npm run test:e2e
      - npm run build
```

### 18.2 Dockerfile (Multistage)

```dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine AS production
WORKDIR /app
RUN addgroup -S app && adduser -S app -G app
USER app
COPY --from=builder /app/dist        ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=10s --retries=3 CMD wget -qO- http://localhost:3000/health/live || exit 1
CMD ["node", "dist/main.js"]
```

### 18.3 Deploy Order

```
1. npm run db:migrate          <- BEFORE app starts
2. Start new containers
3. Wait for /health/ready to return 200
4. Route traffic to new containers
5. Drain and stop old containers
```

---

## 19. Operational Readiness

### 19.1 Graceful Shutdown

```ts
@Injectable()
export class DatabaseService implements OnApplicationShutdown {
  async onApplicationShutdown(signal?: string): Promise<void> {
    logger.log(`Graceful shutdown (${signal})`);
    await this.pool.end();
  }
}
```

`app.enableShutdownHooks()` must be called in main.ts.

### 19.2 Production Env Checklist

```
DATABASE_URL              REQUIRED
REDIS_URL                 REQUIRED
JWT_ED25519_PRIVATE_KEY   REQUIRED
JWT_ED25519_PUBLIC_KEY    REQUIRED
RAZORPAY_KEY_SECRET       REQUIRED
RAZORPAY_WEBHOOK_SECRET   REQUIRED
MSG91_AUTH_KEY            REQUIRED
BETTER_AUTH_SECRET        REQUIRED
ALLOWED_ORIGINS           REQUIRED (not *)
NODE_ENV=production
ENABLE_SWAGGER=false      REQUIRED in prod
LOG_LEVEL=info
```

---

## 20. Error Contracts & Error Codes

### 20.1 Response Envelope

```ts
// Success
{ success: true, data: T }

// Error
{
  success: false,
  error: {
    code:     string,       // lowercase, from ErrorCodes enum
    message:  string,       // safe to show to user
    trace_id: string,       // from X-Request-ID header
    details?: object,       // e.g., { limit, current }
    issues?:  ZodIssue[],   // validation failures only
  }
}
```

### 20.2 Complete Error Code Reference

| HTTP | Code | Meaning |
|---|---|---|
| 401 | TOKEN_INVALID | JWT signature failed or wrong type |
| 401 | TOKEN_EXPIRED | JWT past exp |
| 401 | REFRESH_TOKEN_EXPIRED | Refresh token past expiresAt |
| 401 | REFRESH_TOKEN_REVOKED | Explicitly revoked |
| 401 | REFRESH_TOKEN_REUSE | Reuse attack detected; family revoked |
| 401 | SESSION_REVOKED | Device session revoked |
| 401 | SESSION_EXPIRED | Device session past expiresAt |
| 401 | USER_NOT_FOUND | User soft-deleted |
| 401 | REPLAY_DETECTED | Nonce already seen |
| 403 | USER_BLOCKED | Hard block by admin |
| 403 | USER_SUSPENDED | Account suspended |
| 403 | USER_LOCKED | Temporary lockout |
| 403 | PHONE_NOT_VERIFIED | Phone not verified |
| 403 | DEVICE_BLOCKED | Device hard-blocked |
| 403 | DEVICE_REVOKED | Removed from store |
| 403 | STORE_ACCESS_DENIED | Not a member of this store's account |
| 403 | STEP_UP_REQUIRED | Sensitive action needs step-up |
| 403 | subscription_suspended | Account paused |
| 403 | subscription_feature_limit_reached | Feature not in plan |
| 403 | STORE_LIMIT_REACHED | max_stores exceeded |
| 403 | LOCATION_LIMIT_REACHED | max_locations_per_store exceeded |
| 403 | DEVICE_LIMIT_REACHED | max_devices_per_store exceeded |
| 403 | USER_LIMIT_REACHED | max_users_per_store exceeded |
| 403 | PRODUCT_LIMIT_REACHED | max_products exceeded |
| 402 | subscription_payment_required | Grace over / period over |
| 404 | STORE_NOT_FOUND | Store not found or deleted |
| 404 | NOT_FOUND | Generic resource not found |
| 408 | REQUEST_TIMEOUT | 30s hard timeout |
| 409 | USER_ALREADY_EXISTS | Signup with existing phone |
| 409 | CONFLICT | Generic conflict |
| 422 | OTP_INVALID | Wrong OTP code |
| 422 | OTP_EXPIRED | OTP request past TTL |
| 422 | OTP_MAX_ATTEMPTS | Too many wrong OTP attempts |
| 422 | VALIDATION_FAILED | Zod schema validation failure |
| 429 | RATE_LIMIT_EXCEEDED | Too many requests |
| 429 | STEP_UP_LOCKED | Too many failed step-up attempts |
| 426 | APP_VERSION_DEPRECATED | App below minimum version |
| 500 | INTERNAL_ERROR | Unhandled exception |
| 503 | SERVICE_UNAVAILABLE | Dependency (DB/Redis) down |

---

## 21. Redis Key Reference

All keys prefixed with `REDIS_KEY_PREFIX` (default `ayphen:`).

| Key Pattern | TTL | Description |
|---|---|---|
| session:{deviceSessionId} | 30s | Session cache (guard hot path) |
| snapshot:{userId} | 7 days | Permission snapshot |
| jti:{jti} | token remaining TTL | JWT blacklist |
| nonce:{deviceId}:{nonce} | 10 min | Replay protection |
| device_challenge:{challengeId} | 5 min | Single-use device challenge |
| dev_otp:{phone} | 5 min | Dev-mode OTP (non-production only) |
| otp_rate:ip:{ip} | 1 min | OTP rate limit per IP |
| otp_rate:phone:{phone} | 5 min | OTP rate limit per phone |
| stepup:attempts:{deviceSessionId} | configurable | Step-up attempt counter |
| web_stepup:{sessionId} | configurable | Web step-up counter |
| refresh_idem:{idempotencyKey} | 60s | Refresh token dedup |
| idem:{idempotencyKey} | 24h | General mutation idempotency |
| user_deleted:{userId} | 5s | User revocation micro-cache |
| lock:sub-reconciliation | 270s | Distributed cron lock (multi-instance) |

---

## 22. Rules at a Glance

### Dependency Rules
- Dependencies point down and inward ONLY. Repository never imports service. Service never imports controller.
- base.ts exports column shapes only. FK references go in each table file (prevents circular imports).

### Format Rules
- snake_case at HTTP edges (request body, response). camelCase everywhere inside.
- Request Mapper is the ONLY inbound translation point (snake -> camel).
- Response Mapper is the ONLY outbound translation point (camel -> snake).
- Response Mappers list fields explicitly, NEVER spread. New columns are invisible by default.

### Data Rules
- All monetary values in paise (integer). NEVER floating point.
- All timestamps in UTC with timezone.
- Soft delete via deleted_at. NEVER hard-delete user data.
- Account name is internal only. Store name, GST, address go on customer invoices.

### Subscription Rules
- ONE account_subscription per account. NEVER per-store, NEVER per-user.
- Trial starts at first store creation, NOT at signup.
- Reads are NEVER blocked. Only writes are gated.
- Degradation is BINARY: in-window = full; closed = read-only. Never gradual.
- Downgrade = LOCK, never delete. Everything restores on upgrade.
- Device limits MUST read from account_subscription via plan_entitlements. NEVER from store_subscription.
- max_locations_per_store is INCLUSIVE of Head Office (value 1 = HQ only, no branches).
- Head Office (isPrimary=true) can NEVER be locked regardless of plan or downgrade.

### Auth Rules
- phoneVerified set true on first successful OTP verification.
- JWT must have type: 'access'. Refresh tokens rejected if used as access tokens.
- Account lockout: LOGIN_MAX_ATTEMPTS failures -> LOGIN_LOCKOUT_MINUTES lock.
- Refresh token reuse -> revoke entire familyId (all tokens in chain).
- Subscription data is NOT in the permission snapshot. It has its own subscriptionVersion channel.

### Service Rules
- ANY write to 2 or more repositories MUST use UnitOfWork.
- Pre-transaction: read-only validation. Inside transaction: writes. Post-transaction: EventBus.
- NEVER hold a transaction lock across external API calls (Razorpay, MSG91).
- Side effects (push, email, audit) go through EventBus. NEVER direct calls inside services.

### Background Job Rules
- Cron expressions in env config. NEVER hardcoded in source.
- All crons use overlap prevention (isRunning flag or Redis SETNX for multi-instance).
- All crons expose stats via /health/crons.
- Slow query threshold: 500ms. Log warning + emit metric. Use withQueryTiming() wrapper.

### Security Rules
- Secrets NEVER logged (pino redact covers auth headers, passwords, OTPs, tokens).
- StoreGuard applies to EVERY route with :storeId. Tenant isolation is non-negotiable.
- ENABLE_SWAGGER=false in production.
- X-Powered-By header disabled.
- trust proxy set correctly for load-balanced deployments.
- db connections tracked as Gauge (not Counter) because they go up AND down.
- CacheTTL units verified per cache-manager version. Use CachedForHours/Minutes/Seconds named helpers.

---

*End of Ayphen Retail Backend Architecture PRD*
