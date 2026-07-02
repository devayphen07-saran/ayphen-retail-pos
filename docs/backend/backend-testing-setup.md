# Ayphen Retail — Backend Testing Setup & Strategy

> **App:** Ayphen Retail (NestJS · Drizzle ORM · PostgreSQL · Redis · offline-first POS)
> **Scope:** the complete testing strategy AND the runnable scaffolding — container
> lifecycle, factories, helpers, config, and the risk-driven test suites this backend needs.
> **Principle:** this system's risk is concentrated in SQL correctness (point-in-time auth,
> tenant isolation), concurrency (limits, slots, token rotation), and cache versioning.
> Tests are weighted toward integration, where those bugs actually live.

---

## Table of Contents

1. [Testing Philosophy for This Backend](#1-testing-philosophy-for-this-backend)
2. [The Testing Pyramid](#2-the-testing-pyramid)
3. [Directory Structure](#3-directory-structure)
4. [Container Lifecycle](#4-container-lifecycle)
5. [DB & Redis Clients](#5-db--redis-clients)
6. [Migrations & Fast Reset](#6-migrations--fast-reset)
7. [App Builder](#7-app-builder)
8. [Factories](#8-factories)
9. [Helpers — Seed, Auth, Time, Concurrency](#9-helpers--seed-auth-time-concurrency)
10. [Jest Configuration](#10-jest-configuration)
11. [package.json Scripts](#11-packagejson-scripts)
12. [Unit Tests — What to Cover](#12-unit-tests--what-to-cover)
13. [Integration Tests — What to Cover](#13-integration-tests--what-to-cover)
14. [E2E Tests — Critical Journeys](#14-e2e-tests--critical-journeys)
15. [Contract Tests](#15-contract-tests)
16. [Load / Performance Tests](#16-load--performance-tests)
17. [Security Tests](#17-security-tests)
18. [What NOT to Over-Test](#18-what-not-to-over-test)
19. [Example Test Files](#19-example-test-files)
20. [CI Wiring](#20-ci-wiring)
21. [Coverage Targets](#21-coverage-targets)
22. [Build Order](#22-build-order)

---

## 1. Testing Philosophy for This Backend

Generic "write unit tests" advice does not fit this system. The hardest correctness lives in
places unit tests cannot reach:

- **Point-in-time authorization** — a SQL query reconstructing permission state at a past instant.
- **Tenant + location isolation** — cross-table joins that must never leak another account's data.
- **Concurrency limits (TOCTOU)** — races that only appear under parallel load.
- **Permission cache versioning** — Redis behavior across role changes.

These require a **real Postgres and a real Redis**. Mocking the database here would produce a
green suite that fails in production, because the bugs are *in* the SQL and *in* the cache
semantics. The integration layer therefore carries the most weight.

**Core rules:**
- Never mock Postgres or Redis for RBAC / subscription / sync tests. Use Testcontainers.
- Tests run against the SAME global app config (pipes, filters, interceptors) as production.
- Isolate tests by truncation between each test, not by re-migrating.
- Concurrency tests must fire genuinely parallel requests, not sequential ones.

---

## 2. The Testing Pyramid

```
        ┌─────────────────┐
        │   E2E (few)     │  Full HTTP + DB + Redis — critical journeys only
        ├─────────────────┤
        │  Integration    │  Service + real Postgres + real Redis —
        │    (many)       │  the bulk of RBAC / subscription / sync value
        ├─────────────────┤
        │  Unit (most)    │  Pure logic: mappers, validators, permission math
        └─────────────────┘

   +  Contract tests   — response-shape stability for the mobile client
   +  Load tests       — hot paths at production concurrency
   +  Security tests   — authorization matrix, JWT attacks, injection
   +  Concurrency tests— TOCTOU races (part of integration, called out separately)
```

Unlike a typical CRUD service where unit tests dominate, **integration is the widest band
here** because SQL correctness and cache behavior are where this system can silently break.

---

## 3. Directory Structure

```
test/
├── setup/
│   ├── containers.ts          # Testcontainers: Postgres + Redis lifecycle
│   ├── db.ts                  # Drizzle client bound to the test container
│   ├── redis.ts               # Redis client bound to the test container
│   ├── migrate.ts             # run migrations against the test DB
│   ├── truncate.ts            # fast table reset between tests
│   ├── app.ts                 # build the Nest app for integration/e2e
│   ├── global-setup.ts        # one-time container boot for the whole run
│   ├── global-teardown.ts     # stop containers after the run
│   └── after-env.ts           # per-test reset (beforeEach)
├── factories/                 # build valid domain rows with sane defaults
│   ├── user.factory.ts
│   ├── account.factory.ts
│   ├── store.factory.ts
│   ├── location.factory.ts
│   ├── role.factory.ts
│   ├── subscription.factory.ts
│   ├── device.factory.ts
│   └── index.ts
├── helpers/
│   ├── auth.helper.ts         # mint JWTs, sign requests, login flows
│   ├── seed.helper.ts         # compose factories into scenarios
│   ├── time.helper.ts         # explicit timestamps for point-in-time tests
│   └── concurrency.helper.ts  # fire N parallel requests, collect results
├── unit/                      # pure logic — no containers
│   ├── permission-math.spec.ts
│   ├── validators.spec.ts
│   ├── mappers.spec.ts
│   └── matrix-integrity.spec.ts
├── integration/               # service + real Postgres + Redis
│   ├── tenant-isolation/
│   ├── point-in-time/
│   ├── concurrency/
│   ├── subscription/
│   ├── permission-cache/
│   └── auth/
├── contract/
├── e2e/
└── jest.config.ts
```

---

## 4. Container Lifecycle

Boot Postgres + Redis **once per run**, not per test file. Per-file boots are far too slow.
Isolate tests via truncation instead.

```ts
// test/setup/containers.ts
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, StartedRedisContainer } from '@testcontainers/redis';

let pg: StartedPostgreSqlContainer;
let redis: StartedRedisContainer;

export async function startContainers() {
  // Start both in parallel — saves several seconds per run
  [pg, redis] = await Promise.all([
    new PostgreSqlContainer('postgres:15-alpine')
      .withDatabase('ayphen_test')
      .withUsername('test')
      .withPassword('test')
      // tmpfs: data lives in RAM, never touches disk — much faster for tests
      .withTmpFs({ '/var/lib/postgresql/data': 'rw' })
      .start(),
    new RedisContainer('redis:7-alpine').start(),
  ]);

  process.env.DATABASE_URL = pg.getConnectionUri();
  process.env.REDIS_URL = redis.getConnectionUrl();

  return { pg, redis };
}

export async function stopContainers() {
  await Promise.all([pg?.stop(), redis?.stop()]);
}

export const getPgUri = () => pg.getConnectionUri();
export const getRedisUrl = () => redis.getConnectionUrl();
```

```ts
// test/setup/global-setup.ts — Jest globalSetup, runs ONCE before all tests
import { startContainers } from './containers';
import { runMigrations } from './migrate';

export default async function () {
  const { pg } = await startContainers();
  await runMigrations(pg.getConnectionUri());   // schema built once for the whole run
}
```

```ts
// test/setup/global-teardown.ts — Jest globalTeardown, runs ONCE after all tests
import { stopContainers } from './containers';

export default async function () {
  await stopContainers();
}
```

---

## 5. DB & Redis Clients

Clients bound to the containers, lazily created and reused.

```ts
// test/setup/db.ts
import { drizzle, PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../../src/db/schema';

let client: postgres.Sql;
let db: PostgresJsDatabase<typeof schema>;

export function getDb() {
  if (!db) {
    client = postgres(process.env.DATABASE_URL!, { max: 5 });
    db = drizzle(client, { schema });
  }
  return db;
}

export async function closeDb() {
  await client?.end();
}
```

```ts
// test/setup/redis.ts
import Redis from 'ioredis';

let redis: Redis;

export function getRedis() {
  if (!redis) redis = new Redis(process.env.REDIS_URL!);
  return redis;
}

export async function closeRedis() {
  await redis?.quit();
}
```

---

## 6. Migrations & Fast Reset

Run migrations **once** at global setup. Between tests, truncate — never re-migrate.

```ts
// test/setup/migrate.ts
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

export async function runMigrations(uri: string) {
  const sql = postgres(uri, { max: 1 });
  await migrate(drizzle(sql), { migrationsFolder: './src/db/migrations' });
  await sql.end();
}
```

```ts
// test/setup/truncate.ts — fast reset in milliseconds, not seconds
import { getDb } from './db';
import { sql } from 'drizzle-orm';
import { getRedis } from './redis';

export async function resetDb() {
  const db = getDb();
  // Single statement, respects FKs via CASCADE, resets identity sequences
  await db.execute(sql`
    DO $$
    DECLARE r RECORD;
    BEGIN
      FOR r IN (
        SELECT tablename FROM pg_tables
        WHERE schemaname = 'public'
          AND tablename NOT LIKE '__drizzle%'   -- keep migration bookkeeping
      ) LOOP
        EXECUTE 'TRUNCATE TABLE ' || quote_ident(r.tablename) || ' RESTART IDENTITY CASCADE';
      END LOOP;
    END $$;
  `);
}

export async function resetRedis() {
  await getRedis().flushdb();
}

export async function resetAll() {
  await Promise.all([resetDb(), resetRedis()]);
}
```

---

## 7. App Builder

Build the Nest app for integration and E2E tests. **Critical discipline:** extract the
`main.ts` bootstrap (global pipes, filters, interceptors) into a shared `applyGlobalConfig(app)`
function called from BOTH `main.ts` and this builder. Otherwise tests run a subtly different
app than production, and the difference is exactly where bugs hide.

```ts
// test/setup/app.ts
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { AppModule } from '../../src/app.module';
import { applyGlobalConfig } from '../../src/bootstrap/apply-global-config'; // shared with main.ts

let app: INestApplication;

export async function buildApp(): Promise<INestApplication> {
  if (app) return app;
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],   // real module — env already points at containers
  }).compile();

  app = moduleRef.createNestApplication();
  applyGlobalConfig(app);   // SAME pipes/filters/interceptors as production
  await app.init();
  return app;
}

export async function closeApp() {
  await app?.close();
  app = undefined as any;
}
```

```ts
// src/bootstrap/apply-global-config.ts — extracted from main.ts, used by both
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { AllExceptionsFilter } from '../common/filters/all-exceptions.filter';
import { RequestContextInterceptor } from '../common/interceptors/request-context.interceptor';

export function applyGlobalConfig(app: INestApplication) {
  app.useGlobalPipes(new ValidationPipe({
    whitelist: true, forbidNonWhitelisted: true, transform: true, stopAtFirstError: false,
  }));
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(new RequestContextInterceptor());
  // ...any other global config
}
```

---

## 8. Factories

Each factory returns a valid row with sane defaults; the test overrides only the fields it
cares about. This is what makes tests readable.

```ts
// test/factories/user.factory.ts
import { getDb } from '../setup/db';
import { users } from '../../src/db/schema';
import { randomUUID } from 'crypto';

export async function createUser(overrides: Partial<typeof users.$inferInsert> = {}) {
  const db = getDb();
  const [user] = await db.insert(users).values({
    id: randomUUID(),
    guuid: randomUUID(),
    phone: `+9198${Math.floor(10000000 + Math.random() * 89999999)}`,
    name: 'Test User',
    phoneVerified: true,
    status: 'active',
    isBlocked: false,
    permissionsVersion: 1,
    failedLoginAttempts: 0,
    ...overrides,
  }).returning();
  return user;
}
```

```ts
// test/factories/account.factory.ts
import { getDb } from '../setup/db';
import { accounts, accountUsers, accountSubscription } from '../../src/db/schema';
import { randomUUID } from 'crypto';

export async function createAccount(opts: { ownerUserId: string } & Record<string, any>) {
  const db = getDb();
  const [account] = await db.insert(accounts).values({
    id: randomUUID(),
    accountNumber: `ACC-${randomUUID().slice(0, 6).toUpperCase()}`,
    name: "Test Owner's Business",   // internal only — never on invoices
    ...opts,
  }).returning();

  await db.insert(accountUsers).values({
    accountFk: account.id,
    userFk: opts.ownerUserId,
    isOwner: true,
    isCoOwner: false,
    isAccountant: false,   // account-level ownership flags only
  });

  return account;
}
```

```ts
// test/factories/subscription.factory.ts
import { getDb } from '../setup/db';
import { accountSubscription } from '../../src/db/schema';
import { randomUUID } from 'crypto';
import { addDays } from 'date-fns';

export async function createSubscription(opts: {
  accountFk: string;
  planFk: string;
  status?: string;
  daysValid?: number;
} & Record<string, any>) {
  const db = getDb();
  const validUntil = addDays(new Date(), opts.daysValid ?? 15);
  const [sub] = await db.insert(accountSubscription).values({
    id: randomUUID(),
    accountFk: opts.accountFk,
    planFk: opts.planFk,
    status: opts.status ?? 'trialing',
    trialEndsAt: validUntil,
    accessValidUntil: validUntil,
    subscriptionVersion: 1,
    hasUsedTrial: true,
    ...opts,
  }).returning();
  return sub;
}
```

```ts
// test/factories/store.factory.ts
import { getDb } from '../setup/db';
import { stores, locations } from '../../src/db/schema';

export async function createStore(overrides: Partial<typeof stores.$inferInsert> = {}) {
  const db = getDb();
  const [store] = await db.insert(stores).values({
    accountFk: overrides.accountFk!,        // required — force caller to supply
    name: 'Test Store',
    gstNumber: '29ABCDE1234F1Z5',           // GST lives on the STORE (per-state)
    address: '123 Test St',
    phone: '+919876543210',
    invoicePrefix: 'INV',
    invoiceCounter: 0,
    locked: false,
    ...overrides,
  }).returning();

  // Head Office auto-provision — mirror production store-create behavior
  await db.insert(locations).values({
    storeFk: store.id,
    name: 'Head Office',
    isPrimary: true,
    displayOrder: 0,
    locked: false,
  });

  return store;
}
```

```ts
// test/factories/location.factory.ts
import { getDb } from '../setup/db';
import { locations } from '../../src/db/schema';

export async function createLocation(overrides: Partial<typeof locations.$inferInsert> = {}) {
  const db = getDb();
  const [loc] = await db.insert(locations).values({
    storeFk: overrides.storeFk!,
    name: 'Branch',
    isPrimary: false,
    displayOrder: 1,
    locked: false,
    ...overrides,
  }).returning();
  return loc;
}
```

```ts
// test/factories/role.factory.ts
import { getDb } from '../setup/db';
import { userRoleMapping, roles } from '../../src/db/schema';

/** Assign a system or custom role to a user in a store. */
export async function assignRole(
  userId: string,
  roleCode: string,
  storeId: number,
  opts: { assignedAt?: Date; revokedAt?: Date } = {},
) {
  const db = getDb();
  const [role] = await db.select().from(roles).where(/* eq(roles.code, roleCode) */);
  await db.insert(userRoleMapping).values({
    userFk: userId,
    roleFk: role.id,
    storeFk: storeId,
    assignedAt: opts.assignedAt ?? new Date(),
    revokedAt: opts.revokedAt ?? null,
  });
}
```

```ts
// test/factories/device.factory.ts
import { getDb } from '../setup/db';
import { devices } from '../../src/db/schema';
import { randomUUID } from 'crypto';

export async function createDevice(overrides: Partial<typeof devices.$inferInsert> = {}) {
  const db = getDb();
  const [device] = await db.insert(devices).values({
    id: randomUUID(),
    userFk: overrides.userFk!,
    publicKey: 'ed25519-test-key',
    publicKeyHash: randomUUID(),
    platform: 'android',
    isBlocked: false,
    ...overrides,
  }).returning();
  return device;
}
```

```ts
// test/factories/index.ts
export * from './user.factory';
export * from './account.factory';
export * from './subscription.factory';
export * from './store.factory';
export * from './location.factory';
export * from './role.factory';
export * from './device.factory';
```

---

## 9. Helpers — Seed, Auth, Time, Concurrency

### Seed helper — compose factories into whole scenarios

```ts
// test/helpers/seed.helper.ts
import { createUser, createAccount, createStore, assignRole, createSubscription } from '../factories';

/** A ready-to-use owner with account, store, subscription, and Head Office. */
export async function seedOwnerWithStore(planFk = 'free-plan-id') {
  const user = await createUser();
  const account = await createAccount({ ownerUserId: user.id });
  await createSubscription({ accountFk: account.id, planFk });
  const store = await createStore({ accountFk: account.id });
  await assignRole(user.id, 'STORE_OWNER', store.id);
  return { user, account, store };
}

/** Two separate tenants — the fixture for every tenant-isolation test. */
export async function seedTwoTenants() {
  const a = await seedOwnerWithStore();
  const b = await seedOwnerWithStore();
  return { a, b };
}
```

### Auth helper — mint tokens, attach replay headers

```ts
// test/helpers/auth.helper.ts
import request from 'supertest';
import { randomUUID } from 'crypto';
import { signJwt } from '../../src/auth/core/crypto.service';

export function mintAccessToken(userId: string, sessionId: string, pv = 1) {
  return signJwt({ sub: userId, sid: sessionId, type: 'access', pv });
}

/** Wraps supertest so every request carries bearer + replay headers to pass MobileJwtGuard. */
export function authed(app: any, token: string) {
  const base = () => ({ nonce: randomUUID(), ts: Date.now().toString() });
  return {
    get: (url: string) => {
      const { nonce, ts } = base();
      return request(app.getHttpServer()).get(url)
        .set('Authorization', `Bearer ${token}`).set('x-nonce', nonce).set('x-timestamp', ts);
    },
    post: (url: string, body?: any) => {
      const { nonce, ts } = base();
      return request(app.getHttpServer()).post(url)
        .set('Authorization', `Bearer ${token}`).set('x-nonce', nonce).set('x-timestamp', ts)
        .send(body);
    },
    del: (url: string) => {
      const { nonce, ts } = base();
      return request(app.getHttpServer()).delete(url)
        .set('Authorization', `Bearer ${token}`).set('x-nonce', nonce).set('x-timestamp', ts);
    },
  };
}
```

### Time helper — explicit timestamps for point-in-time tests

```ts
// test/helpers/time.helper.ts
export function at(iso: string): Date {
  return new Date(iso);
}

/** The canonical fired-employee timeline used across point-in-time suites. */
export const T = {
  before: at('2026-06-01T14:55:00Z'),   // sale queued (still authorized)
  revoke: at('2026-06-01T15:00:00Z'),   // role/location revoked
  after:  at('2026-06-01T15:05:00Z'),   // later mutation (no longer authorized)
};
```

### Concurrency helper — fire N parallel requests

```ts
// test/helpers/concurrency.helper.ts
export async function fireParallel<T>(count: number, fn: (i: number) => Promise<T>) {
  const results = await Promise.allSettled(
    Array.from({ length: count }, (_, i) => fn(i)),
  );
  return {
    fulfilled: results.filter(r => r.status === 'fulfilled').length,
    rejected:  results.filter(r => r.status === 'rejected').length,
    results,
  };
}
```

---

## 10. Jest Configuration

```ts
// test/jest.config.ts
import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '..',
  globalSetup: '<rootDir>/test/setup/global-setup.ts',
  globalTeardown: '<rootDir>/test/setup/global-teardown.ts',
  setupFilesAfterEnv: ['<rootDir>/test/setup/after-env.ts'],
  testTimeout: 30_000,          // containers + real DB need headroom
  maxWorkers: 1,                // shared containers → serial to avoid cross-test bleed
  testMatch: ['**/test/**/*.spec.ts'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.module.ts',
    '!src/**/*.d.ts',
    '!src/main.ts',
  ],
};
export default config;
```

```ts
// test/setup/after-env.ts — runs before each test, cleans the slate
import { resetAll } from './truncate';
import { closeDb } from './db';
import { closeRedis } from './redis';

beforeEach(async () => {
  await resetAll();   // truncate all tables + flush Redis
});

afterAll(async () => {
  await closeDb();
  await closeRedis();
});
```

### Note on parallelism

`maxWorkers: 1` forces serial execution because all tests share the same containers via
truncation. When the suite grows and serial time hurts, switch to **one database per Jest
worker**: create `ayphen_test_${JEST_WORKER_ID}` in global-setup and point each worker's
`DATABASE_URL` at its own DB. That yields parallel tests with zero cross-contamination.
**Start serial; add worker-sharding only when suite time actually hurts** — do not
pre-optimize this.

---

## 11. package.json Scripts

```json
{
  "scripts": {
    "test": "jest -c test/jest.config.ts",
    "test:unit": "jest -c test/jest.config.ts test/unit",
    "test:integration": "jest -c test/jest.config.ts test/integration",
    "test:e2e": "jest -c test/jest.config.ts test/e2e --runInBand",
    "test:watch": "jest -c test/jest.config.ts --watch",
    "test:ci": "jest -c test/jest.config.ts --coverage --ci"
  }
}
```

---

## 12. Unit Tests — What to Cover

Fast, deterministic, no containers.

### Permission math (`EffectivePermissions`)
- Union of roles is correct OR-logic: Cashier (Order.create) + Manager (Order.delete) → both granted.
- Empty roles → empty permissions, never default-allow.
- `checkCrud` / `checkSpecial` return exactly what the matrix says.
- `canCreate(limit, current)`: `null` = unlimited; `current === limit` blocked; boundary at
  `limit - 1`, `limit`, `limit + 1`.
- **USER system role never contributes store permissions** — resolution for a store considers
  only roles with `store_fk = :storeId`; system roles excluded.

### Validators (100% branch coverage)
- `IsGstNumber` — valid GSTIN passes; wrong checksum/format fails; test state-code edges.
- `IsIndianPhone` — `+91`, `91`, 10-digit with 6–9 prefix pass; short/invalid fail.
- `IsValidPrice` — 2-decimal boundary, negative rejected, 3-decimal rejected.
- `IsValidSku`, `IsPositiveInteger`, `IsNonNegativeInteger`, `IsTrimmedNonEmpty`.

### Mappers (100% — they are pure)
- snake_case ↔ camelCase both directions.
- **Secret-stripping:** `currentJti`, `currentJtiExp`, `revokedReason` are ABSENT from output
  (assert absence, not just undefined).
- Never spread an entity — a new sensitive column must not auto-appear.

### Matrix integrity validator
- Missing entity in `STORE_OWNER_CRUD` → throws at load.
- Lowercase special action code → throws.
- Confirms the startup guard itself works.

---

## 13. Integration Tests — What to Cover

Service + real Postgres + real Redis. This is where the system's real correctness lives.

### 13.1 Tenant Isolation (P0 security — the single most important suite)

Every failure here is a data breach. Write as a matrix:
`{owner, cashier, unassigned} × {own store, other store, own location, other location} × {read, write}`.

- User A (Store 1) calls any `GET/POST /stores/2/...` → 403/404, never data.
- Same `404 STORE_NOT_ACCESSIBLE` for non-existent and inaccessible stores (timing-oracle parity).
- A role in Store 1 leaks zero permissions into Store 2.
- **Location isolation:** user assigned to Anna Nagar cannot POST to Velachery even with the
  right store — the dual gate (role AND location) both enforced.
- Cross-account product/order/customer reads and writes all denied.

### 13.2 Point-in-Time Authorization (offline sync — trickiest logic)

Seed rows with explicit historical timestamps; this logic cannot be verified by inspection.

- Mutation queued at 2:55pm, user revoked 3:00pm, synced 3:30pm → **accepted** (authorized at asOf).
- Mutation queued at 3:05pm (after revocation) → **rejected** `MUTATION_NOT_AUTHORIZED_AT_TIME`.
- **Critical-action carve-out:** a *refund* queued offline by a since-revoked user → **rejected**
  even if asOf was valid, because critical actions re-check live permission at sync time.
- **Blocked device / deleted user voids the entire queue:** every pending mutation rejected
  regardless of asOf.
- **Location point-in-time (`wasAssignedToLocationAt`):** sale queued for Velachery while
  assigned, user moved off Velachery at 3pm; queued 2:55pm → accepted; queued 3:05pm → rejected.
- Grant existed at asOf but revoked before sync → accepted. Grant created after asOf → rejected.
- STORE_OWNER/CO_OWNER bypass evaluated at the historical instant (owner *at asOf*, not now).

### 13.3 Permission Cache & Versioning (H-6)

- Role revoked → `permissionsVersion` bumped → next request busts cache → DB re-read → new
  permissions applied.
- Assert the **real stale window**: with 30s session cache, a permission change is visible
  within session-TTL, not instantly. (Honesty check — do not assert "instant".)
- Versioned cache key `perm:{userId}:{storeId}:v{pv}` — old key naturally unreferenced after bump.
- Cache corruption: inject malformed JSON into Redis → request falls through to DB, does not
  error, does not deny.
- Critical operation (30s TTL) vs standard (300s TTL) — verify the TTL actually differs.

### 13.4 Concurrency / Race Conditions (TOCTOU — must be genuinely parallel)

- **Limit enforcement (H1):** fire 20 concurrent `POST /products` against plan limit 5 →
  exactly 5 succeed, rest get `PRODUCT_LIMIT_REACHED`. Final DB count is exactly 5, never 6+.
  This test *must fail* against naive count-then-insert and *pass* against atomic enforcement.
- **Device slot claim:** two devices racing for the last slot → exactly one wins.
- **Refresh token rotation:** two concurrent refreshes with the same token → one succeeds, one
  detected as reuse → family revoked.
- **Head Office uniqueness:** concurrent store creates → exactly one primary location per store.

### 13.5 Subscription Lifecycle & Write-Gating

- Trial → active on payment; active → past_due after period end; past_due → write-blocked after grace.
- **Reads never blocked:** GET works in every subscription state including expired/paused.
- **Writes blocked** only when `access_valid_until` passed → 402.
- Reconciliation cron transitions only the correct rows (trialing past trial_ends_at, active
  past period_end).
- Cron overlap prevention: two concurrent cron runs → work done once.
- Entitlement enforcement at create points (max_stores/locations/devices/users/products) —
  atomic, races covered under 13.4.

### 13.6 Auth Flows

- OTP: correct code succeeds; wrong increments attempts; N wrong → account locked;
  expired OTP rejected.
- JWT: expired → 401; refresh-token-used-as-access → rejected (type check); tampered signature → rejected.
- Replay: same nonce twice → second rejected; timestamp outside ±30s → rejected.
- Snapshot signature: tampered snapshot fails Ed25519 verification.
- `phoneVerified` set true on first successful OTP.

---

## 14. E2E Tests — Critical Journeys

Keep few — slow and brittle. Cover only money-path journeys end to end.

1. **Signup → first store creation** → account + subscription + Head Office created atomically;
   if any step fails, nothing is created (rollback test).
2. **OTP login → bootstrap → signed snapshot delivered → offline gate works.**
3. **Cashier full sale:** login → claim device slot → open shift → create order → sync.
4. **Razorpay upgrade:** checkout → verify signature → subscription active → write-gate lifts →
   `X-Subscription-Version` bumps.
5. **Fire-an-employee:** revoke role → next request 404s → queued offline sale still syncs
   (point-in-time) → queued refund does not (critical carve-out).

---

## 15. Contract Tests

The mobile app depends on exact response shapes. A silent field rename bricks the client.

- Snapshot response shape frozen (client parses it offline — breaking change bricks offline mode).
- Error envelope stable: `{ success, error: { code, message, trace_id } }`.
- **No ID emitted as a JSON number** (bigint-as-string boundary): a test asserting every ID
  field in every response is a string. This is the cheap guard against the precision footgun.

---

## 16. Load / Performance Tests

Test hot paths at production-scale concurrency.

- **Guard-chain latency:** the multi-guard path under load; assert p95 acceptable, and that the
  shared-scope-read optimization actually reduced Redis hops (measure hops, not just latency).
- **Permission cache hit ratio** under realistic traffic — low ratio means the DB is doing RBAC
  lookups it should not.
- **Sync endpoints** at the rate-limit boundary — 60/min changes, 20/min delta hold.
- **DB connection pool** under burst — watch `waitingCount`; pool exhaustion is a common outage.
- **Initial sync (cold start)** with a large dataset — the rate-limit-exempt endpoint is a DoS
  surface; measure it.

---

## 17. Security Tests

- **Authorization matrix** (attack framing): every entity × action × {wrong store, wrong
  location, no role} → denied.
- **JWT attacks:** none/alg-confusion, expired, tampered, wrong-audience.
- **Injection:** parameterized queries hold; test a malicious SKU/name.
- **Rate-limit / lockout** engages under brute force.
- **Secrets never leak:** grep responses and logs for token/password/otp fields.
- **Replay & nonce** enforcement.

---

## 18. What NOT to Over-Test

Senior judgment — do not waste effort here:

- **Do not unit-test framework glue** (that NestJS wires a guard) — integration covers it.
- **Do not mock Postgres for RBAC/sync tests** — the bugs are in the SQL; mocks pass while prod
  fails. Testcontainers only.
- **Do not chase 100% line coverage everywhere** — 100% on pure code (mappers, validators,
  permission math), 85% on services; E2E measured by *journeys covered*, not line percentage.
- **Do not test the timing oracle to microseconds** — low-value threat; a coarse "same status
  code, same body shape" assertion is enough.
- **Do not build a Redis stale-key sweeper** — orphaned versioned keys TTL out on their own.
- **Do not build temp-staff scheduling** to exercise `expires_at` — YAGNI until a customer asks.

---

## 19. Example Test Files

### Tenant isolation

```ts
// test/integration/tenant-isolation/cross-store.spec.ts
import { buildApp, closeApp } from '../../setup/app';
import { seedTwoTenants } from '../../helpers/seed.helper';
import { mintAccessToken, authed } from '../../helpers/auth.helper';

describe('Tenant isolation — cross-store access', () => {
  let app;
  beforeAll(async () => { app = await buildApp(); });
  afterAll(async () => { await closeApp(); });

  it('User from Store A cannot read Store B orders', async () => {
    const { a, b } = await seedTwoTenants();
    const token = mintAccessToken(a.user.id, a.session.id);

    const res = await authed(app, token).get(`/stores/${b.store.id}/orders`);

    expect(res.status).toBe(404);            // STORE_NOT_ACCESSIBLE
    expect(res.body).not.toHaveProperty('data');
  });

  it('Non-existent and inaccessible stores return identical shape', async () => {
    const { a } = await seedTwoTenants();
    const token = mintAccessToken(a.user.id, a.session.id);

    const inaccessible = await authed(app, token).get(`/stores/999999/orders`);
    const nonexistent  = await authed(app, token).get(`/stores/888888/orders`);

    expect(inaccessible.status).toBe(nonexistent.status);
    expect(inaccessible.body.error.code).toBe(nonexistent.body.error.code);
  });
});
```

### Concurrency — atomic limit enforcement

```ts
// test/integration/concurrency/product-limit.spec.ts
import { buildApp, closeApp } from '../../setup/app';
import { seedOwnerWithStore } from '../../helpers/seed.helper';
import { mintAccessToken, authed } from '../../helpers/auth.helper';
import { fireParallel } from '../../helpers/concurrency.helper';
import { getDb } from '../../setup/db';
import { products } from '../../../src/db/schema';
import { eq } from 'drizzle-orm';

describe('Concurrency — max_products enforced atomically', () => {
  let app;
  beforeAll(async () => { app = await buildApp(); });
  afterAll(async () => { await closeApp(); });

  it('exactly the limit succeeds under 20 concurrent creates', async () => {
    const { store, user, session } = await seedOwnerWithStore('plan-limit-5');
    const token = mintAccessToken(user.id, session.id);

    await fireParallel(20, () =>
      authed(app, token)
        .post(`/stores/${store.id}/products`, { name: 'X', sellingPrice: 100 })
        .then(r => { if (r.status !== 201) throw new Error('rejected'); return r; }),
    );

    const rows = await getDb().select().from(products).where(eq(products.storeFk, store.id));
    expect(rows.length).toBe(5);   // exactly the limit — never 6+
  });
});
```

### Point-in-time authorization

```ts
// test/integration/point-in-time/offline-mutation.spec.ts
import { buildApp, closeApp } from '../../setup/app';
import { seedOwnerWithStore } from '../../helpers/seed.helper';
import { createUser, assignRole } from '../../factories';
import { T } from '../../helpers/time.helper';
import { rbacRepo } from '../../../src/modules/rbac/...';

describe('Point-in-time authorization — offline sync', () => {
  let app;
  beforeAll(async () => { app = await buildApp(); });
  afterAll(async () => { await closeApp(); });

  it('accepts a create authorized at queue time even after revocation', async () => {
    const { store } = await seedOwnerWithStore();
    const cashier = await createUser();
    // assigned before, revoked at 15:00
    await assignRole(cashier.id, 'CASHIER', store.id, { assignedAt: T.before, revokedAt: T.revoke });

    const ok = await rbacRepo.wasCrudAuthorizedAt({
      userId: cashier.id, storeId: store.id, entity: 'CashMovement', action: 'create', asOf: T.before,
    });
    expect(ok).toBe(true);
  });

  it('rejects a create queued after revocation', async () => {
    const { store } = await seedOwnerWithStore();
    const cashier = await createUser();
    await assignRole(cashier.id, 'CASHIER', store.id, { assignedAt: T.before, revokedAt: T.revoke });

    const ok = await rbacRepo.wasCrudAuthorizedAt({
      userId: cashier.id, storeId: store.id, entity: 'CashMovement', action: 'create', asOf: T.after,
    });
    expect(ok).toBe(false);
  });

  it('rejects a critical action (refund) despite valid asOf — re-checks live', async () => {
    const { store } = await seedOwnerWithStore();
    const cashier = await createUser();
    await assignRole(cashier.id, 'CASHIER', store.id, { assignedAt: T.before, revokedAt: T.revoke });

    // critical actions do NOT use point-in-time; they re-check current permission
    const res = await syncDelta(app, {
      entity: 'Order', action: 'REFUND', client_modified_at: T.before.toISOString(),
    }, cashier);

    expect(res.body.rejected).toContainEqual(
      expect.objectContaining({ reason: 'MUTATION_NOT_AUTHORIZED_AT_TIME' }),
    );
  });
});
```

---

## 20. CI Wiring

```yaml
# .github/workflows/ci.yml
name: CI
on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20', cache: 'npm' }
      - run: npm ci
      - run: npm run type-check
      - run: npm run lint
      - run: npm run db:migrate:dry     # migration dry-run gate
      # Testcontainers boots Postgres + Redis inside the job — no service block needed
      - run: npm run test:unit
      - run: npm run test:integration
      - run: npm run test:e2e
      - run: npm run build
```

```
Every PR:    unit + integration (Testcontainers Postgres+Redis) + contract
             type-check + lint + migration dry-run
Nightly:     full E2E + load + security suites
Pre-deploy:  migrations run BEFORE app boot; health check gates traffic
```

> Testcontainers starts its own Postgres and Redis inside the CI job, so no GitHub `services:`
> block is required. The container library manages Docker directly.

---

## 21. Coverage Targets

| Layer | Target | Rationale |
|---|---|---|
| Mappers (pure) | 100% | Trivial to cover; secret-stripping must never regress |
| Validators | 100% branch | Every edge (GST, phone, price boundary) matters |
| Permission math | 100% | Authorization correctness is non-negotiable |
| Services | 85%+ | Including failure paths, not just happy path |
| Repositories | 80%+ | Via integration tests against real Postgres |
| E2E | Journeys, not % | Critical happy path + main failure per journey |

Line percentage is a proxy, not the goal. The real target: **every tenant-isolation cell,
every point-in-time timeline, and every concurrency race has an explicit test.**

---

## 22. Build Order

Build the scaffolding in this order — the first five items unblock everything else:

1. **Containers + migrate + truncate** — the foundation; nothing runs without it.
2. **DB/Redis clients + app builder** (with the shared `applyGlobalConfig` extraction).
3. **Factories + seed helpers** — start with user, account, store, role, subscription.
4. **Auth + time + concurrency helpers.**
5. **First real suite: tenant isolation** — highest risk, and proves the whole rig works end to end.

Then, in priority order:
6. Concurrency / limit races (only surface under parallel load — easiest to ship broken).
7. Point-in-time auth with the critical-action carve-out (fraud path).
8. Subscription write-gating (revenue + "never brick reads").
9. Everything else.

Once items 1–5 are in place, every subsequent test is a 10-minute job instead of a 2-hour one.

---

*End of Ayphen Retail Backend Testing Setup & Strategy*
