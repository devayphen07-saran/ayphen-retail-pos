# QA Test Cases — Throttle, Health & Cross-Cutting Common Infrastructure

**Scope:** `apps/backend/src/throttle/`, `apps/backend/src/health/`, `apps/backend/src/common/{audit,error-codes.ts,exceptions,filters,interceptors,middleware,pagination,pipes,request-context,redis}`, plus the global wiring in `apps/backend/src/app/app.module.ts` and `apps/backend/src/bootstrap/apply-global-config.ts` that activates this infra on every request.

**Mode:** QA (code-derived) — every threshold, mapping, and default below was read from the actual implementation, not assumed. File:line references are given so a tester can verify against source directly.

**Out of scope:** re-testing the business logic of consumers (login flow correctness, RBAC rule correctness, subscription lifecycle correctness) — those are covered by their own module test-case sets. Here we test only whether the infra itself does what it claims: does the throttle guard block at the right count, does the audit row have the right shape, does the exception filter map the right status/code, does pagination never skip/duplicate a row.

---

## 1. Feature understanding (BA)

### 1.1 Throttle (`throttle/redis-throttler-storage.ts`, `throttle/throttle.module.ts`)

- **What it is:** A global `ThrottlerGuard` (registered as `APP_GUARD` in `app.module.ts`) backed by a custom Redis-backed `ThrottlerStorage` (`RedisThrottlerStorage`), so counters are cluster-wide and survive process restart (the in-memory default would give each replica its own bucket — N replicas would allow N× the intended limit).
- **Default throttler:** name `'global'`, `ttl = 60_000ms`, `limit = env.THROTTLE_GLOBAL_LIMIT` (default **300**, `env.ts:53`). Not overridden per class means routes get exactly this bucket.
- **Per-route overrides** (`mobile-auth.controller.ts`): `login/otp` and `signup/otp` → 5 req/60s; `login/verify` and `signup/verify` → 10 req/60s. `refresh/challenge`, `refresh`, `logout`, `logout/all`, `sessions*`, `step-up/*` have **no override** → fall back to the 300/min global bucket.
- **Skip:** `@SkipThrottle()` on `HealthController` (whole class) and on `RazorpayWebhookController.razorpay-webhook` handler (payment webhooks, high legitimate volume from Razorpay's own IPs).
- **Key derivation (library default, not overridden here):** `sha256(ClassName-HandlerName-ThrottlerName-tracker)`, where `tracker = req.ip`. **This means the counter is scoped per (controller, handler, IP)**, not one shared bucket per IP across the whole API — despite the module doc-comment calling it a "Global per-IP throttler." Two different endpoints for the same IP have independent buckets. This is a real semantic gap between the comment's intent and the library's actual default behavior — flagged in §7.
- **Algorithm (Lua script, `redis-throttler-storage.ts:33-83`):** fixed-window counter using Redis `TIME` (shared clock across replicas). While not blocked, every request increments `totalHits`; once `totalHits > limit`, `isBlocked=1` and a block window opens (`blockExpiresAt = now + blockDuration`). **While blocked, `totalHits` is *not* incremented** (line 55: `if isBlocked == 0 then totalHits = totalHits + 1 end`), so hammering a blocked endpoint doesn't extend the block. When the block window elapses, state resets to `isBlocked=0, totalHits=1` (the resetting request itself counts as hit #1 of the new window) — this is a rolling reset, not an aligned window boundary.
- **`blockDuration`:** not set in `ThrottleModule` config or per-route `@Throttle()` calls, so `@nestjs/throttler`'s own guard defaults it to `ttl` (`throttler.guard.js:84`: `routeOrClassBlockDuration || namedThrottler.blockDuration || ttl`) → **block window = 60s**, same as the counting window, for every throttler in this app.
- **Fail-open on Redis error:** `increment()` catches any Redis error (timeout, connection down) and returns `{ totalHits:0, timeToExpire:0, isBlocked:false, timeToBlockExpire:0 }` — i.e. **the request is allowed through**, logged as a warning. Deliberate: this is a DDoS backstop, not a security gate, and a Redis outage must not turn into a global 500 storm.
- **Response contract on block:** the underlying `@nestjs/throttler` `ThrottlerGuard` sets `Retry-After` (seconds, from `timeToBlockExpire`) and `X-RateLimit-Limit/Remaining/Reset` headers, then throws `ThrottlerException`, which `AllExceptionsFilter.classifyThrottler()` maps to **HTTP 429, `errorCode: 'rate_limit_exceeded'`**.

### 1.2 Health (`health/health.controller.ts`, `*-health.indicator.ts`)

- **Three endpoints**, all `@Public()` and `@SkipThrottle()`, and excluded from the global `/api` prefix (`apply-global-config.ts`: `exclude: [{path:'health'...}, {path:'health/(.*)'...}]`) — reachable at bare `/health`, `/health/live`, `/health/ready`, not `/api/health`.
  - **`GET /health`** — full check: DB (`SELECT 1`), Redis (`PING` → must equal `'PONG'`), heap ≤ 250MB, RSS ≤ 512MB, disk usage at `/` ≤ 90%. Any indicator failing → overall `503` with per-indicator detail (Terminus default behavior).
  - **`GET /health/live`** — liveness: `health.check([])`, i.e. **no indicators at all**. Always `200 {status:'ok'}` as long as the Nest process can route a request. Never fails on a DB/Redis blip — correct for "should the orchestrator kill this pod."
  - **`GET /health/ready`** — readiness: **DB only**. Deliberately excludes Redis: every Redis-dependent path in the app (rate limiting, session cache, snapshot cache) already degrades to a DB fallback on Redis failure (documented in the file's own comment), so failing readiness on a Redis blip would pull every pod out of rotation simultaneously — a worse, correlated outage versus the actual degraded-but-serving state.
- **Indicators:** `DrizzleHealthIndicator` (`SELECT 1` via the shared Drizzle/postgres-js pool) and `RedisHealthIndicator` (`PING` via the shared `REDIS` ioredis client) both throw `HealthCheckError` with `{[key]: {status:'down', message}}` on failure; Terminus aggregates all indicator promises and produces the final `HealthCheckResult` (`status: 'ok'|'error'`, `info`, `error`, `details`).

### 1.3 Audit (`common/audit/audit.service.ts`, `audit.module.ts`)

- **Global module** (`@Global`), single `AuditService` injected wherever a security-relevant event needs an immutable record (login, logout, RBAC denial, role/permission change, subscription change, lookup change, device block, account lock).
- **Two write paths:** `log(entry)` (its own insert, fire-and-forget from the caller's perspective) and `logInTransaction(entry, tx)` (inserted inside the caller's DB transaction — so a failure rolls back the *business* effect too, e.g. login-success audit failing rolls back the whole login transaction per `auth-login.service.ts:239`). Callers choose based on whether the audit row must be atomic with the effect it records.
- **Row shape** (`auditLogs` table): `event` (free string, typically a code like `LOGIN_SUCCESS` or `PERMISSION_DENIED`), `activityType` (one of a closed `ActivityType` union), `prefix`/`suffix` (human sentence halves, e.g. `prefix:'User'`, `suffix:'logged in from 203.0.113.5'`), `userId` (required — the *subject*), `actorId` (optional — who *acted on* the subject, distinct from `userId` for admin-on-behalf-of actions), `storeFk` (optional, RBAC store scope), `isSuccess` (**defaults to `true`** if omitted — `false` marks a denial, SOC2 CC6.3), `entityType`/`entityId`, `metadata` (jsonb, defaults `{}`), `ipAddress`, `userAgent`, server-generated `createdAt`.
- **RBAC denial pattern** (`permissions.guard.ts`): denial audit is written **before** the `ForbiddenException` is thrown, and wrapped in its own try/catch so an audit-insert failure does **not** convert the intended 403 into a 500 and does **not** swallow the denial — the guard still throws 403 either way. This is the opposite atomicity contract from the login-success case: here the audit write is best-effort/non-blocking; in login it's atomic-with-the-effect. Both are intentional per their respective comments — a real dimension to test explicitly (§3.3).

### 1.4 Error handling — error codes, exceptions, filter (`common/error-codes.ts`, `common/exceptions/app.exception.ts`, `common/filters/http-exception.filter.ts`)

- **`ErrorCodes`** is the single source of truth (~90 codes) for the wire contract shared with the mobile client. `AppException.errorCode` is typed to this union; **guards are still allowed to throw a bare `SCREAMING_SNAKE` string as an `HttpException` message** (e.g. `throw new ForbiddenException('STORE_NOT_FOUND')`), and the filter promotes that string to `errorCode` — but nothing at compile time stops a guard from using a code that doesn't exist in `ErrorCodes` (it would just render whatever string as `errorCode`, lowercased).
- **`AppException`** subclasses hard-wire HTTP status per business meaning: `BadRequestError`→400, `UnauthorizedError`→401, `ForbiddenError`→403, `PaymentRequiredError`→402, `NotFoundError`→404, `ConflictError`→409, `GoneError`→410, `UnprocessableError`→422, `RateLimitError`→429 (default code `RATE_LIMIT_EXCEEDED`), `ServiceUnavailableError`→503 (default code `SERVICE_UNAVAILABLE`).
- **`AllExceptionsFilter`** (`@Catch()`, catches everything) classifies in this precedence: (1) `ThrottlerException` → 429/`RATE_LIMIT_EXCEEDED`; (2) `AppException` → its own status/code, humanizing the message only if it happens to look like a SCREAMING_SNAKE code; (3) any other `HttpException` (Nest built-ins, guard-pattern throws, `ValidationPipe` errors) → a multi-branch classification (see below); (4) a Postgres driver error unwrapped from `DrizzleQueryError.cause` → mapped by SQLSTATE; (5) anything else → 500/`INTERNAL_ERROR`, internals never exposed, stack logged server-side only.
- **HttpException sub-classification (`classifyHttpException`)**, in order:
  1. `response.message` is an **array** → validation-error shape (`ValidationPipe` or Zod `parse()`): joined with `'; '`, `errorCode = VALIDATION_FAILED`, and a raw Zod `issues[]` array is preserved if present.
  2. `response.message` is a **string** and `response.errorCode` is also present → both passed through as-is (this is how `AppException`-shaped bodies built manually, e.g. by the `ValidationPipe` `exceptionFactory`, surface their code).
  3. `response.message` is a **string matching `^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$`** (SCREAMING_SNAKE, must start with a letter) → treated as a guard-pattern code: promoted to `errorCode`, and a humanized prose message is synthesized (`STORE_NOT_FOUND` → `"Store not found"`) so the raw code never leaks as the user-facing message.
  4. Otherwise → the string is used verbatim as `message`, but **`errorCode` falls back to `INTERNAL_ERROR`** regardless of the exception's actual HTTP status. E.g. `throw new ForbiddenException('You are not allowed to do that')` renders as **HTTP 403** with **`errorCode: internal_error`** — a real status/code mismatch baked into the current implementation (§7).
  5. `response.details` (if an object) is passed through as `details` regardless of which message branch fired.
  6. A **string-only** response body (not an object) that matches SCREAMING_SNAKE is likewise promoted; a non-matching string body renders as `exception.message` (the Nest-generated default, e.g. `"Forbidden"`), again with `errorCode: INTERNAL_ERROR`.
- **Postgres mapping (`classifyPgError`):** `23505` unique_violation→409/`DUPLICATE_ENTRY`; `23503` fk_violation→400/`FOREIGN_KEY_VIOLATION`; `23502` not_null_violation→400/`VALIDATION_FAILED`; `22P02` invalid_text_representation (bad UUID/enum literal)→400/`VALIDATION_FAILED`; `23514` check_violation→400/`VALIDATION_FAILED`; any other SQLSTATE → 500/`INTERNAL_ERROR`, logged, message stays generic (constraint/column/query text never echoed to the client, by design).
- **Response envelope (always, on every error):** `{ success:false, statusCode, message, data:null, errorCode: <lowercased>, issues?, details?, requestId, timestamp }`. `requestId` is read from `request.headers['x-request-id']`, which `RequestIdMiddleware` guarantees is populated on every route (it runs on `(.*)` for `ALL` methods, before guards/filters).
- **Bypass path (important cross-cutting nuance):** `apply-global-config.ts` installs an ad-hoc **30-second hard request timeout** that, on firing, calls `res.status(408).json({success:false, statusCode:408, message:'Request timeout', errorCode:'REQUEST_TIMEOUT'})` **directly**, entirely outside `AllExceptionsFilter`. This response is missing `requestId`, `timestamp`, and `data`, and its `errorCode` is **not lowercased** (`'REQUEST_TIMEOUT'`, not `'request_timeout'`) — inconsistent with every other error path in the app. Flagged in §7.

### 1.5 Interceptors & middleware (`common/interceptors/*`, `common/middleware/request-id.middleware.ts`)

- **Global pipeline order** (Nest: middleware → guards → interceptors; explicit registration in `apply-global-config.ts` and `app.module.ts`): `RequestIdMiddleware` (all routes) → `ThrottlerGuard` (APP_GUARD, all routes unless `@SkipThrottle`) → route guards (`MobileJwtGuard`, RBAC guards, etc., not in scope here) → `RequestContextInterceptor` → `SubscriptionHeadersInterceptor` → `ResponseInterceptor`.
- **`RequestIdMiddleware`:** accepts a client-supplied `x-request-id` only if it matches `^[A-Za-z0-9_-]{1,128}$`; otherwise mints a fresh UUID. Mutates `req.headers['x-request-id']` in place (so downstream code always reads a safe value) and mirrors it onto the response header.
- **`RequestContextInterceptor`:** wraps the rest of the pipeline in an `AsyncLocalStorage.run()` context carrying `{user, requestId, ip, userAgent, storeId, accountId}`, so `RequestContextService` works anywhere in the call stack without parameter threading. **Skips entirely (calls `next.handle()` directly, no ALS) when `req.user` is absent** — i.e. on `@Public()` routes with no guard having populated a principal. `storeId`/`accountId` are read from `req.context` (a `TenantGuard`/store-context artifact, not in this module's scope) — if that guard hasn't run, both are `undefined`. Propagates unsubscription (client disconnect) to the inner handler via manual `Subscription` teardown.
- **`ResponseInterceptor`:** wraps every 2xx handler return value in `{success:true, statusCode, message:'Success', data, requestId, timestamp}`, **unless** `@SkipTransform()` is set on the handler or controller (checked via `Reflector.getAllAndOverride`, handler wins over class). Used by the sync module to return PRD wire shapes verbatim.
- **`SubscriptionHeadersInterceptor`:** sets `X-Subscription-Version` and (conditionally) `X-Subscription-Warning: past_due:grace_until_<ISO>` from `req.subscriptionFreshness` (stamped upstream by a subscription guard, out of scope here). No-ops entirely if that field is absent (routes that never ran the guard) or if `res.headersSent` is already true (avoids a write-after-end crash, e.g. after the 30s timeout middleware already responded). Sets headers both eagerly (covers streamed responses) and again on completion (`tap`) as a belt-and-suspenders in case the guard populates the field asynchronously.

### 1.6 Pagination (`common/pagination/cursor.ts`, `paginate.ts`, `paginated-response.ts`)

- **Cursor shape:** `{id, v}` where `v` is the ISO-string sort value (millisecond precision, from `Date.toISOString()`) and `id` is the tie-breaker PK; base64url-JSON-encoded, fully opaque to clients.
- **`decodeCursor`** throws `BadRequestError(INVALID_CURSOR, ...)` → HTTP 400 on: invalid base64url, invalid JSON, or a parsed object missing/mistyping `id`/`v`.
- **`paginateByCursor`:** generic DESC keyset pagination. Predicate is `(date_trunc('milliseconds', sortColumn), tieColumn) < (cursor.v, cursor.id)` — the `date_trunc` truncation is a deliberate fix for a timestamp-precision mismatch (JS `Date` is ms-precision; Postgres `timestamptz` stores microseconds), because comparing the raw column to the ms-precision cursor value would silently and permanently strand any row sharing the cursor's millisecond with extra sub-ms precision (neither `<` nor `=` matches it). Fetches `limit+1` rows to derive `hasMore` without a second count query; builds `nextCursor` from the last item of the trimmed page.
- **`clampLimit(raw, {def=20, max=100})`:** any non-finite value (`NaN`, `Infinity`, non-numeric string) or `<= 0` falls back to `def`; otherwise floors and caps at `max`. No lower clamp beyond "not ≤ 0" (e.g. `0.4` → `Math.floor(0.4)=0`... but that's already caught by the `<=0` check on the *raw* `n`, before flooring — see boundary case for `0 < raw < 1`).

### 1.7 Request context (`common/request-context/request-context.service.ts`)

- `AsyncLocalStorage`-backed, `@Global` module. `RequestContextInterceptor` is the only writer (via the static `run()`); everything else reads via instance getters (`getUserId`, `getAccountId`, `getStoreId`, `getRequestId`, `getIp`, `getUserAgent`, `get()`, `getContext()`).
- **`getOrThrow()`** throws a **plain `Error`** ("No request context — called outside a request scope"), **not** an `AppException` — if this is ever called from a code path outside the ALS-wrapped request lifecycle (e.g. a background cron job, or a `@Public()` route since the interceptor skips ALS setup when there's no `req.user`), it will surface as an unhandled/500 via the filter's generic branch, not a typed domain error.
- An `@deprecated` instance `run(principal, fn)` exists for one legacy caller (`SnapshotRefreshInterceptor`) — it merges onto any *existing* ALS context if one is present, else starts a minimal one with empty `requestId`/`ip`/`userAgent`. Two different context-creation paths in the same app is itself a source of subtle divergence (e.g. an empty `requestId` in logs) worth a dedicated check.

### 1.8 Redis (`common/redis/redis.provider.ts`, `redis.module.ts`, `typed-cache.ts`)

- **Single shared `ioredis` connection** (`REDIS` token, `@Global`), consumed by the throttler storage, health indicator, and various caches app-wide — exactly one physical connection, not one per module.
- **Client config:** `maxRetriesPerRequest: 3` (bounds a fully-down socket), `commandTimeout: 1500ms` (per-command deadline — rejects a connected-but-hung Redis fast instead of hanging until the 30s HTTP timeout), `connectTimeout: 10_000ms`, linear `retryStrategy` (`min(attempt*200, 5000)`ms). An `error` listener is attached so a connection failure logs instead of crashing the process (ioredis emits `'error'` on every failed attempt; an unhandled `EventEmitter` `'error'` event crashes Node).
- **`RedisLifecycle`** drains the connection (`redis.quit()`) on `OnApplicationShutdown` (SIGTERM/SIGINT), mirroring the Postgres pool's shutdown drain.
- **`readTypedCache<T>`:** reads a JSON string from Redis and Zod-validates it against a caller-supplied schema before returning it. A cache miss (`null`/empty), a JSON parse failure, *and* a schema-validation failure **all** collapse to the same `null` return — i.e. "treat as if it were never cached," so a deploy that changes the cached shape while an old-TTL entry is still alive fails safe into the caller's normal rebuild-from-DB path rather than handing back a wrongly-shaped object.

### Assumptions / ambiguities flagged for confirmation (see also §7)

1. Whether the "global" 300/min throttle is *intended* to be a true global-per-IP bucket (as the code comment states) or a per-endpoint-per-IP bucket (as the actual default `generateKey` produces) is unconfirmed — test cases below verify the **actual** (per-endpoint) behavior and flag the discrepancy.
2. Whether the 30-second timeout middleware's non-standard error envelope (missing `requestId`/`timestamp`, uppercase `errorCode`) is a known/accepted gap or an oversight.
3. Whether `classifyHttpException`'s fallback branch (non-SCREAMING_SNAKE string message → `errorCode: INTERNAL_ERROR` regardless of actual status) is intended, given it produces a 403/404/409/etc. response whose `errorCode` says "internal error."
4. Whether disk/memory health thresholds (250MB heap, 512MB RSS, 90% disk) are tuned for the actual deployment target (container memory limit, disk size) — no config surfaces these as env vars, they're hard-coded in `health.controller.ts`.

---

## 2. Coverage plan

| Sub-area | Happy | Rules | Boundary | Negative | Failure/Recovery | Concurrency | Permission | State | Cross-cutting | UX | Approx. cases |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Throttle | 3 | 4 | 5 | 2 | 3 | 3 | 1 | 1 | 2 | — | 24 |
| Health | 4 | 3 | 3 | 1 | 4 | 1 | — | — | 2 | — | 18 |
| Audit | 3 | 5 | 2 | 2 | 3 | 2 | — | — | 2 | — | 19 |
| Error handling (exceptions/filter/codes) | 3 | 6 | 4 | 5 | 3 | — | — | — | 3 | — | 24 |
| Interceptors & middleware | 4 | 4 | 2 | 3 | 3 | 1 | — | — | 3 | — | 20 |
| Pagination | 3 | 3 | 6 | 3 | 1 | 2 | — | — | 1 | — | 19 |
| Request-context | 2 | 2 | 1 | 2 | 1 | 2 | — | — | 1 | — | 11 |
| Redis infra | 2 | 2 | 1 | 2 | 3 | — | — | — | 1 | — | 11 |
| **Total** | | | | | | | | | | | **~146** |

(UX dimension is largely N/A — this is server infra with no client-facing screens; its "UX" concern is folded into the response-shape/error-message cases under interceptors/error-handling instead.)

---

## 3. Test cases

### 3.1 Throttle

```
ID / Title:        THR-001 — Request under the global limit is allowed
Area:              happy
Criticality:       High
Traces to:         throttle.module.ts global throttler (ttl 60_000ms, limit=env.THROTTLE_GLOBAL_LIMIT, default 300)
Preconditions:     Redis reachable; fresh IP (no prior hits this window) hitting a route with no @Throttle() override, e.g. GET /health... (health is @SkipThrottle, use e.g. GET /api/auth/mobile/sessions with a valid JWT instead)
Input / Data:      1 request from IP 203.0.113.10
Steps:             1. Send GET /api/auth/mobile/sessions with a valid access token.
Expected result:   200 OK. Response headers include X-RateLimit-Limit-global: 300, X-RateLimit-Remaining-global: 299, X-RateLimit-Reset-global: 60 (approx).
Notes:             Verify headers via a raw HTTP client (curl -i), not just the JSON body.
```

```
ID / Title:        THR-002 — 301st request in the same 60s window from one IP is blocked
Area:              rule (satisfied side of the boundary — verifies enforcement)
Criticality:       Critical
Traces to:         redis-throttler-storage.ts:58 (`if totalHits > limit and isBlocked==0 then isBlocked=1`)
Preconditions:     Same IP, same route (so same generateKey bucket), Redis reachable.
Input / Data:      300 successful requests then a 301st, all within 60s, from IP 203.0.113.10 to the same handler.
Steps:             1. Fire 300 requests in quick succession. 2. Immediately fire request #301.
Expected result:   Requests 1–300 return normal status codes. Request #301 returns HTTP 429, body errorCode:"rate_limit_exceeded", message "Too many requests — please slow down and try again later". Response header Retry-After-global ≈ 60 present.
Notes:             Use a route with no override so the 300 default applies cleanly; a 300-request burst test — run against a test/staging Redis, not shared with other suites (see THR-010 for key-scoping interaction).
```

```
ID / Title:        THR-003 — Exactly at the limit (request #300) still succeeds
Area:              boundary
Criticality:       High
Traces to:         redis-throttler-storage.ts:58 — condition is `totalHits > limit`, strictly greater, so hit #300 (== limit) must pass.
Preconditions:     299 prior successful hits this window, same IP/route.
Input / Data:      Request #300.
Steps:             1. Send the 300th request in the window.
Expected result:   200 OK (or route's normal success code), not blocked. X-RateLimit-Remaining-global: 0.
Notes:             The off-by-one boundary (limit vs limit+1) is the single highest-value case in this file — verify precisely, not "roughly 300."
```

```
ID / Title:        THR-004 — login/otp is blocked after 5 requests/min (stricter override)
Area:              rule
Criticality:       Critical
Traces to:         mobile-auth.controller.ts:92 @Throttle({global:{limit:5,ttl:60_000}})
Preconditions:     Fresh IP, no prior hits to POST /api/auth/mobile/login/otp this window.
Input / Data:      6 calls to login/otp with a valid phone number, all from the same IP, within 60s.
Steps:             1. Send request 1–5. 2. Send request 6.
Expected result:   Requests 1–5 return 200 (OTP challenge issued each time, or per-phone rate-limit business error from the service layer — not throttle-blocked). Request 6 returns 429 rate_limit_exceeded, regardless of whether the underlying phone number is even valid.
Notes:             This throttle check must fire even for a nonexistent/malformed phone — it runs in the guard before the handler's own validation.
```

```
ID / Title:        THR-005 — login/verify allows 10/min, distinct bucket from login/otp
Area:              rule
Criticality:       High
Traces to:         mobile-auth.controller.ts:109 @Throttle({global:{limit:10,ttl:60_000}}); key = per (Controller,Handler,IP)
Preconditions:     Same IP has already been blocked on login/otp (THR-004) in the same window.
Input / Data:      10 calls to login/verify from the same (now-blocked-on-otp) IP.
Steps:             1. Trigger THR-004's block on login/otp. 2. Immediately send 10 requests to login/verify from the same IP.
Expected result:   All 10 login/verify requests are evaluated against their own 10/min bucket, unaffected by the login/otp block — requests 1-10 succeed (or fail on business rules), an 11th would 429.
Notes:             Proves the per-handler key scoping from §1.1 — being blocked on one endpoint does not block a different endpoint for the same IP. Confirms the "global" naming is about the throttler config name, not a shared counter.
```

```
ID / Title:        THR-006 — signup/otp and login/otp are independent buckets despite identical limit config
Area:              rule
Criticality:       Medium
Traces to:         generateKey includes ClassName-HandlerName — identical @Throttle({limit:5,ttl:60_000}) on two different handlers.
Preconditions:     Same IP.
Input / Data:      5 requests to login/otp (fills its bucket) then 1 request to signup/otp.
Steps:             1. Exhaust login/otp's 5-request bucket. 2. Call signup/otp once.
Expected result:   signup/otp's request succeeds (its own independent 5/min bucket, unaffected by login/otp's state).
Notes:             Distinguishes route-level isolation from a shared "OTP send" abuse counter — if the intent was a combined OTP-send limit, this test proves that's NOT what's implemented (each is separately fungible for an attacker).
```

```
ID / Title:        THR-007 — block persists across requests within the block window, does not reset early
Area:              rule / boundary
Criticality:       High
Traces to:         redis-throttler-storage.ts:64 timeToBlockExpire calc; blockDuration defaults to ttl=60s (throttler.guard.js:84)
Preconditions:     IP is currently blocked (past THR-002).
Input / Data:      3 more requests sent at +10s, +30s, +50s into the 60s block window.
Steps:             1. Trigger a block. 2. Send additional requests at the stated offsets.
Expected result:   All 3 requests return 429; totalHits in the Redis hash does NOT increase during the block (verify via redis-cli HGET on the throttle:global:<key> hash — totalHits stays at 301, doesn't climb to 304).
Notes:             Verifies redis-throttler-storage.ts:54-56 — hits aren't counted while blocked, so hammering a blocked client can't artificially extend anything, and doesn't corrupt the counter for when the block lifts.
```

```
ID / Title:        THR-008 — block lifts after the block window and the client gets exactly 1 fresh hit
Area:              rule / boundary
Criticality:       High
Traces to:         redis-throttler-storage.ts:64-68 (isBlocked reset to 0, totalHits reset to 1)
Preconditions:     IP was blocked at T0; block window is 60s.
Input / Data:      1 request sent at T0+61s.
Steps:             1. Trigger a block at T0. 2. Wait until T0+61s (or mock/advance Redis TIME in a test harness). 3. Send 1 request.
Expected result:   Request succeeds (200/normal), X-RateLimit-Remaining-global: <limit-1> (e.g. 299 for the 300-limit bucket), confirming the counter reset to 1, not accumulated from before the block.
Notes:             This is a rolling reset, not a calendar-aligned window — the new window starts at the moment of the first post-block request, not at a fixed clock boundary.
```

```
ID / Title:        THR-009 — Redis outage fails open (does not 500 or 429 falsely)
Area:              failure/recovery
Criticality:       Critical
Traces to:         redis-throttler-storage.ts:108-114 (catch → allow through, totalHits:0)
Preconditions:     Redis is unreachable (stop the Redis container / block the port) or times out (>1500ms per redis.provider.ts commandTimeout).
Input / Data:      Any request to any throttled route.
Steps:             1. Take Redis down. 2. Send a normal request to a throttled (non-@SkipThrottle) route. 3. Send 500 requests in a burst.
Expected result:   Every request is allowed through (no 429, no 500 due to throttling) — a warning is logged ("Throttler storage unavailable, allowing request through: <message>") but the request completes on its own merits. No X-RateLimit headers are meaningfully accurate (Remaining stays at limit).
Notes:             This is intentionally NOT a security gate during an outage — confirm this is still the desired posture (it is, per the module's own comment), and confirm no other guard/rate-limit compensates during the outage (e.g. per-phone OTP limiter in the service layer, which is DB-backed and separate — verify it's still enforced).
```

```
ID / Title:        THR-010 — Redis recovers mid-outage; state resumes cleanly with no stale block
Area:              failure/recovery
Criticality:       High
Traces to:         redis-throttler-storage.ts increment() — no local/in-memory fallback state is kept during an outage.
Preconditions:     Redis down, several requests already fired-and-allowed (THR-009), then Redis comes back up.
Input / Data:      Requests before, during, and after a Redis restart.
Steps:             1. Take Redis down; send 10 requests to a 5/min route (all allowed, THR-009). 2. Restart Redis. 3. Immediately send request #11.
Expected result:   Request #11 is evaluated fresh — since no hits were durably recorded during the outage, it is treated as hit #1 of a new window, not blocked.
Notes:             Confirms there's no separate "lost writes get replayed" mechanism — the outage window's request volume is simply not counted at all, by design.
```

```
ID / Title:        THR-011 — slow Redis (command hangs) times out at 1500ms and fails open, not a 30s hang
Area:              failure/recovery
Criticality:       High
Traces to:         redis.provider.ts commandTimeout:1500 + redis-throttler-storage.ts catch block.
Preconditions:     Redis reachable but artificially delayed (e.g. via a proxy/toxiproxy injecting >1500ms latency on EVAL).
Input / Data:      1 request to a throttled route.
Steps:             1. Inject latency > 1500ms on the Redis connection. 2. Send a request.
Expected result:   The request resolves within ~1.5s (not the full 30s HTTP timeout), allowed through, with the fail-open warning logged.
Notes:             Verifies the commandTimeout actually protects the throttle path end-to-end, not just in isolation.
```

```
ID / Title:        THR-012 — @SkipThrottle() routes are never rate limited, even under heavy load
Area:              rule (negative side — verifies the exemption)
Criticality:       High
Traces to:         health.controller.ts:15 @SkipThrottle(); razorpay-webhook.controller.ts:26 @SkipThrottle()
Preconditions:     None.
Input / Data:      1000 rapid requests to GET /health from one IP within 60s.
Steps:             1. Fire 1000 GET /health requests in under 60s from a single IP.
Expected result:   All 1000 return 200 (or 503 on genuine dependency failure) — never 429. No X-RateLimit-* headers are set on the response (the guard's canActivate short-circuits via shouldSkip before touching Redis).
Notes:             Also verify the Razorpay webhook endpoint the same way, since it's the only other exempted route and carries real payment traffic.
```

```
ID / Title:        THR-013 — two different client IPs get independent buckets
Area:              rule / concurrency
Criticality:       High
Traces to:         throttler.guard.js getTracker() → req.ip; RedisThrottlerStorage keys include the IP via the caller-supplied `key`.
Preconditions:     Two distinct source IPs (or X-Forwarded-For values, given trust proxy:1).
Input / Data:      IP A sends 300 requests (fills its bucket) to a route; IP B sends 1 request to the same route.
Steps:             1. Exhaust IP A's bucket. 2. Send 1 request as IP B.
Expected result:   IP B's request succeeds normally — completely unaffected by IP A's state.
Notes:             Confirms tenant/client isolation for the shared-infra rate limiter — a single abusive IP cannot lock out other users of the same endpoint.
```

```
ID / Title:        THR-014 — trust-proxy 1 derives IP from X-Forwarded-For, not spoofable by an arbitrary header value
Area:              negative
Criticality:       Critical
Traces to:         apply-global-config.ts app.set('trust proxy', 1); request-ip.ts getRequestIp() comment ("derives req.ip from the proxy-appended XFF hop... a client cannot spoof")
Preconditions:     App deployed behind exactly 1 trusted proxy hop (per trust-proxy:1 semantics — Express takes the rightmost/closest-to-app entry it trusts, not the client-supplied leftmost).
Input / Data:      A request whose X-Forwarded-For header is attacker-controlled with many comma-separated fake IPs prepended, e.g. "9.9.9.9, 203.0.113.10".
Steps:             1. Send 300 requests each claiming a different fake leftmost IP in X-Forwarded-For, all through the same real proxy hop. 2. Send request #301.
Expected result:   Express resolves req.ip to the same real client IP regardless of the fabricated leftmost XFF entries (trust proxy:1 trusts exactly one hop from the socket peer, ignoring attacker-supplied entries beyond that). Request #301 IS blocked — the attacker cannot bypass the limit by varying the spoofable part of XFF.
Notes:             This is an infra-correctness case, not a throttle-logic case per se, but it's the exact mechanism the rate limiter depends on for IP integrity — a misconfigured trust-proxy value (e.g. `true` behind multiple hops, or 1 with 2 real hops) would silently make this limiter trivially bypassable. Verify the deployed proxy topology actually matches trust-proxy:1's assumption.
```

```
ID / Title:        THR-015 — concurrent requests at the boundary don't allow more than limit+ε through (race on the counter)
Area:              concurrency
Criticality:       Critical
Traces to:         redis-throttler-storage.ts Lua script — single EVAL, atomic per Redis's single-threaded execution model.
Preconditions:     Fresh window, limit=5 (e.g. login/otp), one IP.
Input / Data:      10 requests fired truly concurrently (not sequentially) from the same IP.
Steps:             1. Fire 10 requests in parallel (e.g. Promise.all of 10 HTTP calls).
Expected result:   Exactly 5 succeed, exactly 5 receive 429 — the Lua script's atomicity (single EVAL = single Redis command, no read-modify-write race) prevents more than 5 from slipping through even under concurrency.
Notes:             This is the single most important concurrency case for the whole throttle subsystem — an in-memory or non-atomic implementation would typically overshoot under this exact test. Confirms the choice of Lua-script atomicity over a naive GET-then-SET was necessary and correct.
```

```
ID / Title:        THR-016 — refresh/refresh-challenge endpoints (no per-route override) share the 300/min default and are never fully un-throttleable
Area:              rule
Criticality:       Medium
Traces to:         mobile-auth.controller.ts refresh/refresh-challenge handlers have @Public() but no @Throttle() — inherits the class-level global config.
Preconditions:     Fresh IP.
Input / Data:      301 requests to POST /api/auth/mobile/refresh/challenge.
Steps:             1. Send 301 requests.
Expected result:   Request 301 is 429 — confirms these @Public(), no-JWT-required endpoints are NOT accidentally exempted from throttling (they'd be an attractive DoS/enumeration target otherwise since they need no auth).
Notes:             Distinguishes "no explicit @Throttle() override" from "@SkipThrottle()" — only the latter is a true exemption.
```

```
ID / Title:        THR-017 — env.THROTTLE_GLOBAL_LIMIT is honored when overridden
Area:              boundary / rule
Criticality:       Medium
Traces to:         env.ts:53 THROTTLE_GLOBAL_LIMIT z.coerce.number().default(300); throttle.module.ts limit: env.THROTTLE_GLOBAL_LIMIT
Preconditions:     Deploy/test with THROTTLE_GLOBAL_LIMIT=3 in the environment.
Input / Data:      4 requests to a no-override route from one IP.
Steps:             1. Start the app with THROTTLE_GLOBAL_LIMIT=3. 2. Send 4 requests.
Expected result:   Requests 1-3 succeed, request 4 is 429 — confirms the limit is actually read from env at boot, not hard-coded.
Notes:             Also test THROTTLE_GLOBAL_LIMIT=0 and a non-numeric value (see THR-018).
```

```
ID / Title:        THR-018 — malformed/zero THROTTLE_GLOBAL_LIMIT env value
Area:              negative / boundary
Criticality:       Low
Traces to:         env.ts z.coerce.number().default(300) — z.coerce.number() on a non-numeric string throws a Zod error at boot (env validation), not at request time.
Preconditions:     Set THROTTLE_GLOBAL_LIMIT="abc" in env.
Input / Data:      App boot.
Steps:             1. Start the app with THROTTLE_GLOBAL_LIMIT=abc.
Expected result:   App fails to boot with a clear Zod validation error identifying THROTTLE_GLOBAL_LIMIT — never starts serving traffic with an undefined/NaN limit. Separately, THROTTLE_GLOBAL_LIMIT=0 should boot successfully and block literally every request on that throttler (totalHits=1 > limit=0 on the very first hit).
Notes:             Confirms fail-fast at startup rather than a runtime surprise; the limit=0 case is a legitimate boundary a deploy might hit by misconfiguration and should degrade predictably (block everything), not crash or silently fall back to a default.
```

```
ID / Title:        THR-019 — X-RateLimit-Reset reflects real time-to-expire, not a static ttl echo
Area:              boundary
Criticality:       Low
Traces to:         redis-throttler-storage.ts:48-52 timeToExpire calc from `expiresAt - now`
Preconditions:     A window already 40s in progress (60 total).
Input / Data:      1 request at the 40s mark.
Steps:             1. Send the first request of a window. 2. Wait 40s. 3. Send a second request.
Expected result:   X-RateLimit-Reset-global on the second response is ≈20 (60-40), not 60 — confirms the countdown is live, not reset per-request.
Notes:             A caller polling this header to back off correctly depends on this being accurate.
```

```
ID / Title:        THR-020 — logout/step-up endpoints (JWT-guarded, no @Throttle override) still count against the 300/min default per (user's) IP
Area:              cross-cutting
Criticality:       Medium
Traces to:         Same generateKey mechanism — tracker is IP, not userId, even on authenticated routes.
Preconditions:     Two different authenticated users sharing one IP (e.g. same NAT/corporate network — realistic for retail POS backends where multiple terminals may share one WAN IP).
Input / Data:      User A makes 300 requests to POST /api/auth/mobile/logout; User B (different JWT, same IP) makes 1 more request to the same route.
Steps:             1. User A exhausts the 300/min bucket for that route+IP. 2. User B, same IP, calls the same route.
Expected result:   User B's request is ALSO blocked (429) — the throttle key is IP+route, not IP+route+user, so users behind the same IP/NAT share fate on this limiter.
Notes:             Important for a retail POS deployment where many terminals in one store may share a single outbound IP — this is a real production risk (one terminal's traffic can rate-limit siblings), worth flagging explicitly even though it's "working as coded." See §7.
```

### 3.2 Health

```
ID / Title:        HLT-001 — GET /health returns 200 with all indicators up
Area:              happy
Criticality:       High
Traces to:         health.controller.ts check()
Preconditions:     DB reachable, Redis reachable, heap < 250MB, RSS < 512MB, disk usage at '/' < 90%.
Input / Data:      GET /health (bare path, no /api prefix).
Steps:             1. Send GET /health.
Expected result:   200 OK, body { status:'ok', info:{database:{status:'up'}, redis:{status:'up'}, memory_heap:{status:'up'}, memory_rss:{status:'up'}, disk:{status:'up'}}, error:{}, details:{...same...} }.
Notes:             Confirm reachable at bare /health, NOT /api/health (global prefix exclusion) — a request to /api/health should 404.
```

```
ID / Title:        HLT-002 — GET /health/live always 200 while the process is up, regardless of dependencies
Area:              happy / rule
Criticality:       Critical
Traces to:         health.controller.ts live() — health.check([]) — zero indicators
Preconditions:     DB and Redis both down.
Input / Data:      GET /health/live.
Steps:             1. Stop DB and Redis. 2. Send GET /health/live.
Expected result:   200 OK, body {status:'ok', info:{}, error:{}, details:{}} — liveness never reflects dependency state, only "can this process route an HTTP request."
Notes:             This is the case that most directly protects against an orchestrator killing/restarting pods during a shared dependency outage — verify it explicitly, don't assume from reading the code.
```

```
ID / Title:        HLT-003 — GET /health/ready returns 503 when DB is down
Area:              rule (violated side)
Criticality:       Critical
Traces to:         health.controller.ts ready() — DB-only check
Preconditions:     DB unreachable (stop DB container / block port).
Input / Data:      GET /health/ready.
Steps:             1. Stop the DB. 2. Send GET /health/ready.
Expected result:   503, body {status:'error', info:{}, error:{database:{status:'down', message:'<connection error text>'}}, details:{database:{status:'down',...}}}. Message text does not leak connection string/credentials.
Notes:             Verify the error message field is the sanitized errorMessage() output, not a raw driver exception with connection details.
```

```
ID / Title:        HLT-004 — GET /health/ready stays 200 when Redis is down but DB is up
Area:              rule
Criticality:       Critical
Traces to:         health.controller.ts ready() comment — Redis deliberately excluded from readiness
Preconditions:     Redis down, DB up.
Input / Data:      GET /health/ready.
Steps:             1. Stop Redis only. 2. Send GET /health/ready.
Expected result:   200 OK — readiness ignores Redis entirely; the pod stays in rotation.
Notes:             This is the most important single behavioral assertion in the health subsystem — a naive "ready = all dependencies up" implementation would fail this, causing a correlated full-fleet outage on any Redis blip. Explicitly confirm GET /health (full check) DOES report redis:down in parallel, for alerting purposes, even though /ready ignores it.
```

```
ID / Title:        HLT-005 — GET /health returns 503 when Redis PING replies something other than PONG
Area:              boundary / negative
Criticality:       Medium
Traces to:         redis-health.indicator.ts:20 `if (pong !== 'PONG') throw new Error(...)`
Preconditions:     A way to make Redis return a non-PONG reply to PING (e.g. a proxy/mock injecting a corrupted reply), or simulate via a Redis in a weird replica/loading state that still connects but errors on PING.
Input / Data:      GET /health.
Steps:             1. Force a non-PONG PING reply. 2. Send GET /health.
Expected result:   503, redis indicator down with message "unexpected PING reply: <value>".
Notes:             Distinguishes "connection refused" failures from "connected but semantically unhealthy" — both must be caught.
```

```
ID / Title:        HLT-006 — GET /health returns 503 when heap exceeds 250MB
Area:              boundary
Criticality:       Medium
Traces to:         health.controller.ts:33 checkHeap('memory_heap', 250*1024*1024)
Preconditions:     Force the process heap usage above 250MB (e.g. a load test that allocates memory, or a memory-leak repro).
Input / Data:      GET /health under memory pressure.
Steps:             1. Drive heap usage above 250MB. 2. Send GET /health.
Expected result:   503, memory_heap indicator reports down with actual vs threshold values; other indicators (db/redis/rss/disk) still report their own true state independently (Terminus aggregates all, doesn't short-circuit on first failure).
Notes:             Confirm the 250MB/512MB thresholds are intentional for the actual container memory limit (see open question in §7) — a container with a 256MB limit would essentially always fail this check.
```

```
ID / Title:        HLT-007 — GET /health returns 503 when disk usage at '/' exceeds 90%
Area:              boundary
Criticality:       Medium
Traces to:         health.controller.ts:35 checkStorage('disk', {thresholdPercent:0.9, path:'/'})
Preconditions:     Disk at '/' filled above 90% (test env with a small/loop-mounted volume, or a disk-fill script).
Input / Data:      GET /health.
Steps:             1. Fill disk past 90%. 2. Send GET /health.
Expected result:   503, disk indicator down with actual usage percent.
Notes:             In a containerized deploy, '/' may be an ephemeral overlay separate from the actual data volume — verify this check monitors the volume that actually matters (open question, §7).
```

```
ID / Title:        HLT-008 — /health, /health/live, /health/ready are all unauthenticated
Area:              permission (negative — verifies the intentional bypass)
Criticality:       High
Traces to:         health.controller.ts @Public()
Preconditions:     None — no Authorization header.
Input / Data:      GET each of the 3 endpoints with no Authorization header, and with a garbage/expired one.
Steps:             1. Call each endpoint with no auth header. 2. Call each with an expired/garbage JWT.
Expected result:   All 3 respond normally based on dependency health alone — never 401, regardless of auth header presence/validity (monitoring/orchestrator probes carry no credentials).
Notes:             Also verify no PII or internal architecture beyond up/down + a short message ever appears in the body (info-disclosure check).
```

```
ID / Title:        HLT-009 — /health is unreachable under /api prefix
Area:              boundary / negative
Criticality:       Medium
Traces to:         apply-global-config.ts setGlobalPrefix exclude list — only 'health' and 'health/(.*)' are excluded, at the bare path.
Preconditions:     None.
Input / Data:      GET /api/health.
Steps:             1. Send GET /api/health.
Expected result:   404 (no controller mounted at that path — the health controller is NOT also duplicated under /api).
Notes:             Confirms operators/load balancers must be configured to probe the bare path, not the prefixed one — a misconfigured LB probing /api/health would perpetually see 404 and could be misread as "app down."
```

```
ID / Title:        HLT-010 — /health/live and /health/ready are not throttled even under load
Area:              cross-cutting
Criticality:       Medium
Traces to:         @SkipThrottle() at class level applies to every method on HealthController, not just check().
Preconditions:     None.
Input / Data:      1000 rapid requests to /health/live from one IP (simulating an orchestrator's aggressive liveness probe interval under a misconfiguration).
Steps:             1. Fire 1000 requests within 60s.
Expected result:   All 1000 succeed — never 429.
Notes:             A false-positive 429 on a liveness probe would trigger orchestrator restarts — this exemption is safety-critical, not just a convenience.
```

```
ID / Title:        HLT-011 — health check response shape matches Terminus's HealthCheckResult contract for monitoring parsers
Area:              rule
Criticality:       Low
Traces to:         @nestjs/terminus HealthCheckResult shape, health.controller.ts's use of @HealthCheck()
Preconditions:     Mixed health (e.g. DB up, Redis down).
Input / Data:      GET /health.
Steps:             1. Force Redis down, DB up. 2. GET /health.
Expected result:   503 overall; `info` contains only the passing indicators (database, memory_heap, memory_rss, disk), `error` contains only the failing one (redis), `details` contains all 5 with per-indicator status — matches the documented Terminus aggregation contract exactly (not just "some failure recorded somewhere").
Notes:             Automated monitoring likely parses `error` keys to alert on the specific failing dependency — verify the shape precisely, field by field.
```

```
ID / Title:        HLT-012 — concurrent health checks don't interfere with each other or with the DB/Redis connection pool under load
Area:              concurrency
Criticality:       Medium
Traces to:         DrizzleHealthIndicator/RedisHealthIndicator share the app's single DB pool / Redis connection.
Preconditions:     App under normal request load.
Input / Data:      50 concurrent GET /health requests while normal API traffic is also flowing.
Steps:             1. Fire 50 concurrent health checks alongside simulated API load.
Expected result:   All health checks complete successfully and promptly (health's SELECT 1 / PING don't get starved by pool exhaustion under reasonable load); API traffic is not meaningfully degraded by the health-check load.
Notes:             Guards against a health-check storm (e.g. an overly aggressive external monitor) starving the shared DB pool used by real traffic.
```

```
ID / Title:        HLT-013 — DB health check surfaces a sanitized message, not a raw connection-string/credential leak
Area:              negative
Criticality:       Critical
Traces to:         drizzle-health.indicator.ts:27 uses errorMessage(err) — err instanceof Error ? err.message : String(err)
Preconditions:     DB down with an auth failure (wrong password) vs. down with connection refused (host unreachable) — two different underlying driver errors.
Input / Data:      GET /health under each condition.
Steps:             1. Point DB config at a valid host with wrong credentials; GET /health. 2. Point at an unreachable host; GET /health.
Expected result:   In both cases, the `message` field is the driver's Error.message text — verify it never includes the DB password or connection string with embedded credentials (postgres.js error messages for auth failures can sometimes include the attempted username — confirm no password ever appears).
Notes:             This is a real information-disclosure risk if the health endpoint is public and the driver's error text is verbose — worth an explicit check, not an assumption.
```

```
ID / Title:        HLT-014 — health.module wiring doesn't require RBAC/tenant context (StoreContext) to resolve
Area:              cross-cutting
Criticality:       Low
Traces to:         health.controller.ts has no @StoreContext(...) decorator; relies purely on @Public()
Preconditions:     RouteCoverageModule validates every route has an RBAC/StoreContext annotation (route-coverage.validator.ts, imported last in app.module.ts).
Input / Data:      App boot.
Steps:             1. Boot the app with RouteCoverageModule active.
Expected result:   App boots successfully — the route-coverage validator either explicitly exempts @Public() routes from requiring @StoreContext, or explicitly allow-lists the health routes; it must not throw a startup error for health's 3 GET routes.
Notes:             This is really a route-coverage-validator test, but failing it would mean the app can't boot at all — worth a smoke check here since it gates whether health even exists at runtime.
```

### 3.3 Audit

```
ID / Title:        AUD-001 — log() inserts a row with all provided fields, defaults applied for omitted ones
Area:              happy
Criticality:       High
Traces to:         audit.service.ts toRow(); isSuccess defaults true; metadata defaults {}
Preconditions:     DB reachable.
Input / Data:      { event:'LOGIN_SUCCESS', activityType:'AUTH_LOGIN', prefix:'User', suffix:'logged in from 203.0.113.5', userId:'<uuid>', ipAddress:'203.0.113.5' } — no isSuccess, actorId, storeFk, entityType, entityId, metadata, userAgent supplied.
Steps:             1. Call auditService.log(entry).
Expected result:   A row is inserted with isSuccess=true, metadata={}, actorId/storeFk/entityType/entityId/userAgent = NULL, createdAt server-generated (now, UTC).
Notes:             Verifies the "defaults true = success" contract that denial logging relies on being the explicit exception.
```

```
ID / Title:        AUD-002 — isSuccess:false correctly marks a denial row (SOC2 CC6.3)
Area:              rule
Criticality:       Critical
Traces to:         permissions.guard.ts denyAudit() — implicitly relies on isSuccess default... (guard's denyAudit doesn't set isSuccess explicitly — check actual behavior)
Preconditions:     A permission-denied event fires.
Input / Data:      A user without the required entity permission attempts a gated action.
Steps:             1. Attempt an action the user's role does not permit. 2. Query the resulting audit_logs row.
Expected result:   The row has event='PERMISSION_DENIED' (or 'SPECIAL_PERMISSION_DENIED'), activityType matching, prefix='Access', suffix='denied on <entity>.<action>'. Confirm what isSuccess actually holds — since permissions.guard.ts's denyAudit() call doesn't appear to set isSuccess explicitly in the entry it builds, it defaults to true per audit.service.ts:69, meaning a PERMISSION_DENIED row is currently recorded with isSuccess=true. Flag this as a genuine finding: a denial event is NOT flagging isSuccess=false, contradicting the field's documented purpose ("false = denial (SOC2 CC6.3)").
Notes:             This looks like a real bug/gap worth raising with dev — the isSuccess flag as coded is not being used the way the type comment says it should be for the one caller (permissions.guard.ts) that most obviously should set it. Confirm by reading the exact object literal passed to audit.log in denyAudit() at runtime/DB row level, not just inferring from the guard snippet reviewed.
```

```
ID / Title:        AUD-003 — logInTransaction rolls back the audit row if the surrounding transaction fails after the audit call
Area:              failure/recovery
Criticality:       Critical
Traces to:         auth-login.service.ts:239 — audit write is inside the same tx as the session update
Preconditions:     Force a failure in a step of the login transaction that runs AFTER the audit insert (e.g. simulate the updateCurrentJti call throwing).
Input / Data:      A login attempt where the post-audit DB write fails.
Steps:             1. Inject a failure after the audit.logInTransaction() call but before tx commit. 2. Attempt login.
Expected result:   The entire transaction rolls back, including the audit row — no LOGIN_SUCCESS audit row exists for this attempt, and no session/JTI update persisted either. Client receives the underlying error (mapped by AllExceptionsFilter), not a false "login succeeded."
Notes:             Confirms the atomic-with-effect contract for this call site — an audit row must never exist without its corresponding effect, or vice versa, for this specific caller.
```

```
ID / Title:        AUD-004 — logInTransaction failure rolls back the whole login (audit failure blocks the business effect)
Area:              failure/recovery
Criticality:       Critical
Traces to:         auth-login.service.ts comment: "a transient audit-write failure must roll back the login"
Preconditions:     Force the audit_logs insert itself to fail (e.g. a constraint violation, or a simulated DB error at that exact statement).
Input / Data:      A login attempt where the audit insert fails.
Steps:             1. Inject a failure specifically at the audit.logInTransaction() call. 2. Attempt login.
Expected result:   The login fails entirely (transaction rolled back) — no session created, no tokens issued, despite the user's credentials/OTP being otherwise valid. Client sees a 5xx or appropriate mapped error, not a successful login.
Notes:             This is the deliberate opposite tradeoff from AUD-005 (denial audit is best-effort) — confirm the login path really does block on audit success, since that's a meaningful availability/correctness tradeoff (an audit-log outage would block all logins).
```

```
ID / Title:        AUD-005 — permission-denial audit failure does NOT prevent the 403 from being returned
Area:              failure/recovery
Criticality:       Critical
Traces to:         permissions.guard.ts denyAudit() try/catch — "must NOT convert the 403 into a 500... log and move on"
Preconditions:     Force the audit insert to fail (e.g. DB constraint violation, DB momentarily unavailable) during a permission check that should deny.
Input / Data:      A user without permission attempts a gated action while the audit_logs table/DB write path is broken.
Steps:             1. Break the audit insert path (e.g. point audit writes at a full/broken table, or mock a DB error for that specific insert). 2. Attempt the forbidden action.
Expected result:   The caller still receives 403 FORBIDDEN / PERMISSION_DENIED — the guard's own error (not a 500 from the audit failure) is what reaches the client. The audit failure itself is logged (server-side) for later investigation, but the denial itself isn't lost or silently allowed.
Notes:             The most important negative-correctness case for the whole audit subsystem: security enforcement (403) must never be gated on the health of the audit pipe. Contrast directly with AUD-004 where the login path's atomicity IS gated on the audit write — confirm both behaviors precisely, they're intentionally different.
```

```
ID / Title:        AUD-006 — actorId vs userId distinguishes acting-on-behalf-of from self-action
Area:              rule
Criticality:       Medium
Traces to:         audit.service.ts AuditLogEntry.actorId comment
Preconditions:     An admin/owner performs an action on another user's behalf (e.g. revoking someone else's role — find a real call site, e.g. role.service.ts / invitation.service.ts).
Input / Data:      Admin U1 revokes a role assignment belonging to user U2.
Steps:             1. Admin U1 revokes U2's role via the API.
Expected result:   The resulting audit row has userId = U2 (the subject whose access changed) and actorId = U1 (who performed it) — distinct values, not both set to the same id.
Notes:             Verify at an actual call site with two distinct real users — a bug here (both fields set to the actor, or both to the subject) would make the audit trail unable to answer "who did this to whom."
```

```
ID / Title:        AUD-007 — metadata is stored as queryable jsonb, not a stringified blob
Area:              rule
Criticality:       Low
Traces to:         db/schema.ts auditLogs.metadata: jsonb(...)
Preconditions:     None.
Input / Data:      { ..., metadata: { platform: 'ios', appVersion: '2.3.1' } }.
Steps:             1. Log an entry with a nested metadata object. 2. Query the row directly via SQL (e.g. SELECT metadata->>'platform' FROM audit_logs WHERE id=...).
Expected result:   The JSON path query succeeds and returns 'ios' — confirms metadata round-trips as real jsonb, not double-encoded/stringified JSON-in-a-string.
Notes:             A common regression: passing JSON.stringify(metadata) into a jsonb column produces a stored JSON *string*, breaking ->> queries silently.
```

```
ID / Title:        AUD-008 — empty/omitted metadata defaults to {} not null
Area:              boundary / edge (empty)
Criticality:       Low
Traces to:         audit.service.ts:72 metadata: entry.metadata ?? {}
Preconditions:     None.
Input / Data:      An entry with no metadata field at all.
Steps:             1. Log an entry omitting metadata.
Expected result:   Stored value is {} (empty JSON object), not SQL NULL — downstream code that does metadata->>'x' on every row (without a NULL guard) doesn't error.
Notes:             Edge case per §5 checklist (empty/null).
```

```
ID / Title:        AUD-009 — very long suffix/metadata values are not silently truncated or rejected
Area:              boundary (long/unusual input)
Criticality:       Low
Traces to:         db/schema.ts — suffix/prefix are text() (unbounded), metadata is jsonb (unbounded).
Preconditions:     None.
Input / Data:      A suffix string of 10,000 characters (e.g. a very long IP/user-agent-derived sentence, or a pathological User-Agent header value flowing into an audit entry elsewhere).
Steps:             1. Log an entry with a 10,000-char suffix.
Expected result:   Insert succeeds; the full string round-trips on read (Postgres text has no practical length cap here). If any calling code truncates before logging, verify where and confirm it's intentional.
Notes:             Combine with unicode/emoji in prefix/suffix (e.g. a user-agent or store name containing emoji) — should round-trip UTF-8 cleanly.
```

```
ID / Title:        AUD-010 — unicode/RTL/emoji in audit fields round-trip correctly
Area:              boundary (long/unusual input)
Criticality:       Low
Traces to:         text columns, Postgres UTF-8 default encoding.
Preconditions:     None.
Input / Data:      suffix containing emoji + RTL Arabic text, e.g. "denied on órders.refund 🚫 مرحبا".
Steps:             1. Log the entry. 2. Read it back.
Expected result:   Byte-for-byte round trip, no mojibake, no truncation mid-multibyte-character.
Notes:             §5 checklist explicit item.
```

```
ID / Title:        AUD-011 — concurrent audit writes for the same user (e.g. rapid repeated denied attempts) don't lose rows or corrupt counts
Area:              concurrency
Criticality:       Medium
Traces to:         audit.service.ts log() — plain INSERT, no upsert/merge logic, so should be race-free by construction.
Preconditions:     None.
Input / Data:      20 concurrent denied requests from the same user hitting the same forbidden action simultaneously.
Steps:             1. Fire 20 concurrent forbidden requests. 2. Count resulting audit_logs rows for that user/entity/action in the same second.
Expected result:   Exactly 20 rows exist — INSERT has no shared-state race, unlike an update-a-counter pattern.
Notes:             Low risk given the append-only INSERT design, but worth one concurrency smoke test since it's the kind of thing that "looks obviously fine" until a trigger/index quietly serializes or drops something.
```

```
ID / Title:        AUD-012 — audit index supports per-user and per-store history queries (not a correctness bug, but a real query-pattern check)
Area:              rule
Criticality:       Low
Traces to:         db/schema.ts idx_audit_logs_user_created, idx_audit_logs_store_created
Preconditions:     Meaningful volume of audit rows across several users/stores.
Input / Data:      A query for "all audit events for user U1, newest first" and "all audit events for store S1, newest first."
Steps:             1. Run both query shapes. 2. EXPLAIN ANALYZE each.
Expected result:   Both use their respective index (idx_audit_logs_user_created / idx_audit_logs_store_created), not a sequential scan, at realistic table sizes.
Notes:             Not a functional-correctness case, but a real production-viability check for an append-only, ever-growing table — flag if a seq scan appears at moderate row counts.
```

```
ID / Title:        AUD-013 — a NULL userId is rejected (not-null constraint)
Area:              negative
Criticality:       Medium
Traces to:         db/schema.ts userId: uuid('user_id').notNull()
Preconditions:     None.
Input / Data:      An AuditLogEntry with userId omitted/undefined at the TypeScript layer (bypassing the type system, e.g. via any-cast, simulating a bug at a call site).
Steps:             1. Attempt to log an entry with userId undefined.
Expected result:   The DB insert throws a not_null_violation (23502); the caller's surrounding code must handle/propagate this — verify at least one real call site's behavior when this happens (does it crash the whole request with a 500 mapped via classifyPgError, or does something swallow it silently?).
Notes:             TypeScript's AuditLogEntry.userId is required (not optional) so this should be unreachable via correct call sites — this test exists to catch any place that constructs the entry with a possibly-undefined value (e.g. from an unauthenticated context) without a compile-time guarantee.
```

```
ID / Title:        AUD-014 — logging survives being called with a storeFk for a store that doesn't (yet) exist mid-transaction (FK/ordering)
Area:              edge (out-of-order)
Criticality:       Low
Traces to:         db/schema.ts storeFk: uuid('store_fk') — check whether this column has an actual FK constraint or is a bare uuid (schema snippet shown didn't include a references() call for storeFk in the visible excerpt).
Preconditions:     None.
Input / Data:      An audit entry referencing a storeFk.
Steps:             1. Inspect db/schema.ts's full auditLogs column definitions for storeFk (and userId/actorId) to confirm whether they carry a DB-level foreign key or are unenforced.
Expected result:   Document whichever is true. If unenforced, add a case verifying a stale/nonexistent storeFk is still accepted (audit trail should survive even a deleted store, since compliance history must outlive the record it references) — if enforced, a deleted store must not break its audit trail (verify ON DELETE behavior: SET NULL / RESTRICT / CASCADE).
Notes:             This determines whether "store deleted → its audit history becomes unreadable/errors" is possible — a real compliance risk either way, worth explicit confirmation.
```

### 3.4 Error handling — exceptions, filter, error codes

```
ID / Title:        ERR-001 — AppException subclass status codes are exactly as documented
Area:              happy / rule
Criticality:       Critical
Traces to:         app.exception.ts — each subclass's hard-coded HttpStatus
Preconditions:     None.
Input / Data:      Throw one instance of each: BadRequestError, UnauthorizedError, ForbiddenError, PaymentRequiredError, NotFoundError, ConflictError, GoneError, UnprocessableError, RateLimitError, ServiceUnavailableError.
Steps:             1. Trigger a code path that throws each subclass (or a unit test constructing each and passing through the filter). 2. Inspect the resulting HTTP status.
Expected result:   400, 401, 403, 402, 404, 409, 410, 422, 429, 503 respectively — exact match, not "in the right ballpark."
Notes:             This is the foundational contract every other module's error handling depends on — a single mismatch here silently breaks client-side status-code switch statements everywhere.
```

```
ID / Title:        ERR-002 — AppException's errorCode and details pass through to the response body verbatim
Area:              happy
Criticality:       Critical
Traces to:         http-exception.filter.ts classifyAppException()
Preconditions:     None.
Input / Data:      throw new NotFoundError(ErrorCodes.PRODUCT_NOT_FOUND, 'Product not found', {sku:'ABC-123'}).
Steps:             1. Trigger this throw. 2. Inspect the response.
Expected result:   404, body { success:false, statusCode:404, message:'Product not found', data:null, errorCode:'product_not_found', details:{sku:'ABC-123'}, requestId:'<uuid>', timestamp:'<ISO>' }.
Notes:             Confirm errorCode is lowercased in the wire body even though the constant/enum value is uppercase — this is the exact mobile-client contract point (PRD §20.2 referenced in error-codes.ts).
```

```
ID / Title:        ERR-003 — AppException message that happens to be SCREAMING_SNAKE gets humanized
Area:              rule / boundary
Criticality:       Medium
Traces to:         http-exception.filter.ts classifyAppException() — `SCREAMING_SNAKE.test(raw) ? humanize(raw) : raw`
Preconditions:     A call site constructs new AppException(ErrorCodes.X, 'OTP_ALREADY_CONSUMED', 422) — i.e. passes a code-shaped string as the human message (the file's own doc comment cites this exact pattern).
Input / Data:      Trigger such a call site (e.g. find/simulate one, or unit-test the filter directly with this exact exception).
Steps:             1. Throw the exception. 2. Inspect response.message.
Expected result:   message: "Otp already consumed" (humanized: lowercased, underscores→spaces, first letter capitalized) — NOT the raw "OTP_ALREADY_CONSUMED" string leaking to the client as prose.
Notes:             Contrast with ERR-002 where the message is already human prose and passes through unchanged — the humanization is conditional, verify both branches.
```

```
ID / Title:        ERR-004 — bare SCREAMING_SNAKE guard-pattern throw is promoted to errorCode and humanized
Area:              rule
Criticality:       Critical
Traces to:         http-exception.filter.ts classifyHttpException() branch 3
Preconditions:     None.
Input / Data:      throw new ForbiddenException('STORE_NOT_FOUND') (the exact pattern cited in the filter's own top-of-file comment).
Steps:             1. Trigger this throw. 2. Inspect response.
Expected result:   403 (from ForbiddenException's own status), errorCode:'store_not_found', message:"Store not found" — the raw code never appears as the message.
Notes:             This is the single most common error-throwing pattern across the RBAC/guard layer per the codebase's own documentation — must be airtight.
```

```
ID / Title:        ERR-005 — guard-pattern code with structured `details` alongside it is preserved
Area:              rule
Criticality:       High
Traces to:         http-exception.filter.ts classifyHttpException() branch 5 — `b['details']` passthrough
Preconditions:     None.
Input / Data:      throw new ForbiddenException({ message:'STORE_LIMIT_REACHED', details:{ limit:5, current:5 } }) (exact pattern cited in the filter's comment).
Steps:             1. Trigger this throw. 2. Inspect response.
Expected result:   403, errorCode:'store_limit_reached', message:"Store limit reached", details:{limit:5, current:5} present in the body.
Notes:             Confirms the structured-context path (used for "why exactly was this denied" UX) survives the guard-pattern promotion.
```

```
ID / Title:        ERR-006 — validation-array HttpException (ValidationPipe / Zod parse()) is joined and coded VALIDATION_FAILED
Area:              rule
Criticality:       Critical
Traces to:         http-exception.filter.ts classifyHttpException() branch 1; apply-global-config.ts ValidationPipe exceptionFactory
Preconditions:     None.
Input / Data:      POST a body missing a required field and with a wrong type for another, e.g. { phone: 12345 } to an endpoint expecting { phone: string, device: {...} }.
Steps:             1. Send the malformed body.
Expected result:   422 (per the exceptionFactory's explicit status), errorCode:'validation_failed', message is a '; '-joined string of all constraint violations (not just the first), no `issues` array (class-validator path — only Zod's parse() attaches `issues`).
Notes:             Verify multiple simultaneous violations are ALL present in the joined message, not just the first one encountered (`errors.flatMap` in apply-global-config.ts's exceptionFactory) — a single-violation test under-covers this.
```

```
ID / Title:        ERR-007 — Zod parse() validation failure preserves structured `issues[]`
Area:              rule
Criticality:       High
Traces to:         http-exception.filter.ts classifyHttpException() branch 1 — `if (Array.isArray(b['issues'])) issues = ...`
Preconditions:     A route using #common/validation/parse.js (Zod) rather than class-validator DTOs, e.g. mobile-auth.controller.ts's parse(body, OtpRequestDtoSchema).
Input / Data:      POST /api/auth/mobile/login/otp with a body failing Zod schema validation (e.g. phone as a number instead of string).
Steps:             1. Send the malformed body.
Expected result:   Response includes a top-level `issues` array with Zod's structured per-field issue objects (path, message, code), in addition to the joined `message` string and errorCode:'validation_failed'.
Notes:             Confirms the mobile client can do field-level error highlighting from `issues`, not just display a flat string — verify the array actually contains per-field structure, not just re-serialized strings.
```

```
ID / Title:        ERR-008 — non-SCREAMING_SNAKE human-message HttpException gets INTERNAL_ERROR code despite a non-500 status (known gap)
Area:              negative (documents a real inconsistency)
Criticality:       High
Traces to:         http-exception.filter.ts classifyHttpException() branch 4 (the else fallback)
Preconditions:     None.
Input / Data:      throw new ForbiddenException('You are not allowed to perform this action').
Steps:             1. Trigger this throw. 2. Inspect response.
Expected result:   AS CURRENTLY CODED: 403 status, but errorCode:'internal_error' and message:'You are not allowed to perform this action' — status and errorCode disagree (client-side code that branches on errorCode rather than statusCode would treat a 403 as a 500-class failure).
Notes:             This is very likely an unintended gap, not a documented design choice — flag for developer confirmation (§7). If any current call site actually throws a plain-English HttpException message (not SCREAMING_SNAKE, no explicit errorCode), this test will demonstrate the mismatch live — search for such call sites as part of running this case.
```

```
ID / Title:        ERR-009 — SCREAMING_SNAKE regex requires a leading letter; a code-shaped string starting with a digit falls through to generic handling
Area:              boundary
Criticality:       Low
Traces to:         http-exception.filter.ts:21 `const SCREAMING_SNAKE = /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/`
Preconditions:     None.
Input / Data:      throw new BadRequestException('2FA_REQUIRED') (hypothetical/contrived — starts with a digit).
Steps:             1. Trigger this throw. 2. Inspect response.
Expected result:   Falls to branch 4 (else): message stays "2FA_REQUIRED" verbatim (not humanized), errorCode:'internal_error' — NOT promoted/humanized like ERR-004.
Notes:             Low real-world likelihood (no current error code in error-codes.ts starts with a digit) but documents the exact regex boundary — useful if a future code is ever named starting with a digit.
```

```
ID / Title:        ERR-010 — string-only HttpException response body matching SCREAMING_SNAKE is promoted the same as an object body
Area:              rule
Criticality:       Medium
Traces to:         http-exception.filter.ts classifyHttpException() final else-if branch — `typeof body === 'string' && SCREAMING_SNAKE.test(body)`
Preconditions:     A rare Nest exception constructed with a raw string response rather than `{message}` (verify whether any current call site does this — HttpException(message) internally always produces {statusCode, message} normally, so this may require a custom exception subclass to trigger — confirm via code search).
Input / Data:      A crafted exception whose getResponse() returns the bare string 'DEVICE_BLOCKED'.
Steps:             1. Trigger it. 2. Inspect response.
Expected result:   errorCode:'device_blocked', message:"Device blocked".
Notes:             If no real call site can produce this shape, mark as a defensive/dead branch — still worth a unit test directly against the filter class to lock in the behavior.
```

```
ID / Title:        ERR-011 — plain HttpException with generic Nest default body (e.g. bare NotFoundException()) still renders coherently
Area:              boundary
Criticality:       Medium
Traces to:         http-exception.filter.ts classifyHttpException() final else — `message = exception.message`
Preconditions:     None.
Input / Data:      A route (or 404 for an unmatched path) that lets Nest throw its bare default NotFoundException().
Steps:             1. Request a URL matching no route.
Expected result:   404, errorCode:'internal_error' (per branch 4 logic, since the default message "Not Found" isn't SCREAMING_SNAKE and carries no explicit errorCode), message:"Not Found" (or "Cannot GET /whatever" — Nest's actual default text — verify exact string).
Notes:             This exact scenario (hitting an unmapped route) happens constantly in production from bots/scanners — confirm the response never leaks a stack trace or route list, just the generic envelope.
```

```
ID / Title:        ERR-012 — unique constraint violation (23505) maps to 409 DUPLICATE_ENTRY, message never leaks the constraint name
Area:              rule
Criticality:       Critical
Traces to:         http-exception.filter.ts classifyPgError() case '23505'
Preconditions:     A unique index exists on some column not already guarded by an app-level pre-check (or force a race — two near-simultaneous inserts of the same unique value).
Input / Data:      Two concurrent signups with the identical phone number (assuming phone has a unique constraint) that both pass an app-level pre-check.
Steps:             1. Fire two concurrent requests creating the same unique value. 2. Inspect the loser's response.
Expected result:   409, errorCode:'duplicate_entry', message:"A record with this value already exists" — no mention of the actual constraint name (e.g. "users_phone_unique") or column name.
Notes:             Directly tests unwrapPgError()'s handling of drizzle-orm's DrizzleQueryError wrapper (rethrow-unique-violation.ts comment: "drizzle-orm (0.44+) wraps every driver error... a plain instanceof check never matches anymore") — verify the unwrap actually works through drizzle's wrapper, not just against a raw postgres.PostgresError.
```

```
ID / Title:        ERR-013 — foreign key violation (23503) maps to 400 FOREIGN_KEY_VIOLATION
Area:              rule
Criticality:       High
Traces to:         http-exception.filter.ts classifyPgError() case '23503'
Preconditions:     An insert/update referencing a non-existent FK target that isn't pre-validated at the app layer.
Input / Data:      Create a record with a storeFk pointing at a UUID that doesn't exist in the stores table (bypassing any app-level existence check, e.g. via a race where the parent was deleted between the app's check and the insert).
Steps:             1. Trigger the FK violation. 2. Inspect response.
Expected result:   400, errorCode:'foreign_key_violation', message:"Referenced record does not exist" — generic, no table/column names leaked.
```

```
ID / Title:        ERR-014 — not-null violation (23502) maps to 400 VALIDATION_FAILED
Area:              rule
Criticality:       Medium
Traces to:         http-exception.filter.ts classifyPgError() case '23502'
Preconditions:     A required DB column has no corresponding app-level required-field check (defense-in-depth scenario) — or simulate directly at the repository layer.
Input / Data:      An insert omitting a not-null column via a path that skips DTO validation (e.g. a raw internal service call).
Steps:             1. Trigger the violation.
Expected result:   400, errorCode:'validation_failed', message:"A required field is missing".
Notes:             Confirms this collapses to the SAME errorCode as a class-validator failure (VALIDATION_FAILED) even though the failure surfaced at the DB layer rather than the pipe layer — a client can't distinguish "pipe caught it" from "DB caught it" from errorCode alone; both are 400/validation_failed. Confirm this is acceptable (it likely is, since the client-facing meaning is the same).
```

```
ID / Title:        ERR-015 — invalid UUID / bad enum literal (22P02) maps to 400 VALIDATION_FAILED with a generic message
Area:              negative / boundary
Criticality:       High
Traces to:         http-exception.filter.ts classifyPgError() case '22P02'
Preconditions:     A route path/query param typed as UUID that reaches the DB layer without a ParseUUIDPipe (or one that does have ParseUUIDPipe — compare both paths).
Input / Data:      GET /api/.../not-a-real-uuid where the param is used directly in a SQL WHERE id = $1::uuid without prior validation.
Steps:             1. Send a request with a syntactically invalid UUID in a param that skips ParseUUIDPipe. 2. Compare with an endpoint that DOES use ParseUUIDPipe (e.g. mobile-auth.controller.ts revokeSession's @Param('id', ParseUUIDPipe)).
Expected result:   The unguarded path: 400, errorCode:'validation_failed', message:"Invalid ID format" (from the PG-error branch). The ParseUUIDPipe-guarded path: also 400/validation_failed but from the pipe layer (different message text, likely Nest's default "Validation failed (uuid is expected)" — verify both independently) — a client sees the same errorCode/status either way, but confirm the message text difference doesn't matter for client behavior (it shouldn't, since clients should key off errorCode/statusCode, not message).
Notes:             Good regression-catcher for "someone removed a ParseUUIDPipe and the DB defense-in-depth layer silently absorbed it" — both paths must still produce a 4xx, never a 500.
```

```
ID / Title:        ERR-016 — check constraint violation (23514) maps to 400 VALIDATION_FAILED
Area:              rule
Criticality:       Medium
Traces to:         http-exception.filter.ts classifyPgError() case '23514' — comment cites users_email_or_phone as an example real constraint.
Preconditions:     A CHECK constraint exists (e.g. users_email_or_phone requiring at least one of email/phone) that the app layer doesn't fully pre-validate for some entry path.
Input / Data:      Attempt to create/update a user record violating the CHECK (e.g. both email and phone null, if the constraint requires at least one).
Steps:             1. Trigger the CHECK violation via a path that reaches the DB without app-level pre-validation.
Expected result:   400, errorCode:'validation_failed', message:"The request violates a data constraint".
```

```
ID / Title:        ERR-017 — an unmapped/unknown Postgres SQLSTATE collapses to 500 INTERNAL_ERROR, logged server-side
Area:              failure/recovery
Criticality:       High
Traces to:         http-exception.filter.ts classifyPgError() default branch — `this.logger.error(...)`
Preconditions:     Trigger a PG error code not in the explicit switch, e.g. '40001' (serialization_failure, from a SERIALIZABLE isolation conflict) or '53300' (too_many_connections).
Input / Data:      Force a serialization failure (concurrent SERIALIZABLE transactions conflicting) if any code path uses that isolation level, or simulate directly.
Steps:             1. Trigger the unmapped PG error. 2. Inspect response and server logs.
Expected result:   500, errorCode:'internal_error', generic message "Internal server error" — the raw PG code/message is NOT in the client response but IS in the server log (`this.logger.error(\`Unhandled PostgresError ${pgErr.code}: ${pgErr.message}\`)`).
Notes:             Verifies no PG error code can ever leak internals to the client just because it wasn't anticipated — the default branch is a safe catch-all, not an accidental pass-through.
```

```
ID / Title:        ERR-018 — a fully unrecognized/non-HttpException/non-PG error (e.g. a plain thrown Error / TypeError from a bug) is safely mapped to 500
Area:              failure/recovery
Criticality:       Critical
Traces to:         http-exception.filter.ts classify() final fallback — `this.logger.error('Unhandled exception', ...)`
Preconditions:     None.
Input / Data:      A handler that throws a plain `new TypeError("Cannot read property 'x' of undefined")` (simulating an actual application bug).
Steps:             1. Trigger the bug. 2. Inspect response and server log.
Expected result:   500, errorCode:'internal_error', message:"Internal server error" exactly — the real error message/stack never appears in the HTTP response, but the full stack IS logged server-side via `exception.stack`.
Notes:             This is the last line of defense against accidental internals leakage (stack traces, file paths, variable names) reaching an external client — must be airtight for literally any uncaught JS error shape (also test throwing a plain string, and throwing `undefined`/`null`, per errorMessage()'s String(err) fallback elsewhere in the codebase — confirm the filter's own `exception instanceof Error ? exception.stack : String(exception)` handles a non-Error throw without crashing the filter itself).
```

```
ID / Title:        ERR-019 — ThrottlerException is classified before AppException/HttpException checks (precedence)
Area:              rule
Criticality:       Medium
Traces to:         http-exception.filter.ts classify() — ThrottlerException checked first; ThrottlerException extends HttpException internally in @nestjs/throttler
Preconditions:     A throttled route at its limit.
Input / Data:      Exceed a route's throttle limit.
Steps:             1. Trigger a 429.
Expected result:   429, errorCode:'rate_limit_exceeded', the throttler-specific message — confirms it's NOT accidentally caught by the generic HttpException branch (which would produce a different, less specific message/code, e.g. potentially INTERNAL_ERROR if ThrottlerException's internal message isn't SCREAMING_SNAKE).
Notes:             Precedence-ordering test — since ThrottlerException technically also satisfies `instanceof HttpException`, the specific `instanceof ThrottlerException` check must run first in the `classify()` if-chain, which it does (line 66 before line 67-68) — verify this order is preserved if the file is ever refactored.
```

```
ID / Title:        ERR-020 — requestId in the error envelope matches the request's own x-request-id (client-supplied or generated)
Area:              cross-cutting
Criticality:       High
Traces to:         http-exception.filter.ts:46 — reads request.headers['x-request-id'], populated upstream by RequestIdMiddleware
Preconditions:     None.
Input / Data:      A request with a caller-supplied X-Request-Id: mobile-abc-123, that then errors.
Steps:             1. Send a request with that header, to a route that errors (e.g. a 404 or a validation failure). 2. Inspect the response's requestId field and the response's echoed x-request-id header.
Expected result:   Both equal 'mobile-abc-123' — confirms end-to-end correlation from client-supplied trace ID through to the error body, for client-side log correlation.
Notes:             Also test with NO client-supplied header — requestId in the error body should be some generated UUID, present and non-empty (never blank/undefined).
```

```
ID / Title:        ERR-021 — errorCode is always lowercase in the wire response, even for codes that are all-uppercase constants
Area:              rule
Criticality:       Medium
Traces to:         http-exception.filter.ts:57 `errorCode: classified.errorCode.toLowerCase()`
Preconditions:     None.
Input / Data:      Any error path producing errorCode 'VALIDATION_FAILED', 'RATE_LIMIT_EXCEEDED', 'STORE_NOT_FOUND', etc.
Steps:             1. Trigger several different error paths (validation, throttle, guard-pattern, AppException).
Expected result:   In every case, the JSON body's errorCode field is fully lowercase snake_case ('validation_failed', 'rate_limit_exceeded', 'store_not_found'), regardless of the internal representation's case.
Notes:             Contrast with ERR-... the 30s-timeout bypass path (see MID- section) which does NOT lowercase — this test is scoped to AllExceptionsFilter-routed errors specifically, to isolate that the filter itself is consistent, before separately flagging the bypass inconsistency.
```

```
ID / Title:        ERR-022 — details object is only present in the response when the exception actually supplied one
Area:              boundary (empty/null)
Criticality:       Low
Traces to:         http-exception.filter.ts:59 `...(classified.details && { details: classified.details })`
Preconditions:     None.
Input / Data:      One error with details (ERR-005) vs. one without (ERR-001's plain NotFoundError with no 4th arg).
Steps:             1. Trigger both. 2. Inspect both response bodies' key sets.
Expected result:   The no-details case's JSON body has NO `details` key at all (not `details: undefined` serialized, not `details: null`) — object-spread conditional inclusion works as intended.
Notes:             A JSON.stringify of `{details: undefined}` would actually omit the key too, but confirm the actual behavior explicitly rather than assuming — same check for `issues`.
```

```
ID / Title:        ERR-023 — error-codes.ts codes stay in sync with what guards actually throw (no orphaned/undeclared codes reach the client)
Area:              rule / cross-cutting
Criticality:       Medium
Traces to:         error-codes.ts top comment: "Guards may still throw a bare SCREAMING_SNAKE code as a message... but that code MUST exist here"
Preconditions:     Static analysis across the codebase.
Input / Data:      Every `throw new XxxException('SOME_CODE')` / `new AppException(ErrorCodes.X, ...)` call site in the backend.
Steps:             1. Grep every guard-pattern throw across the codebase for the SCREAMING_SNAKE literal used. 2. Cross-check each against the ErrorCodes export.
Expected result:   Every literal used as a guard-pattern code corresponds to an entry in ErrorCodes — no call site throws a code absent from the central enum (which would still "work" at runtime — the filter doesn't validate membership — but would silently drift from the mobile client's known code list).
Notes:             This is a static/lint-style check rather than a runtime HTTP test — recommend adding an automated grep-based CI check (or a TS-level exhaustiveness helper) rather than relying on manual QA to catch drift here, since nothing at runtime currently enforces this invariant.
```

```
ID / Title:        ERR-024 — timestamp field is a valid ISO-8601 string reflecting the moment of the error response, not the request start
Area:              boundary
Criticality:       Low
Traces to:         http-exception.filter.ts:61 `timestamp: new Date().toISOString()`
Preconditions:     A handler with an artificial delay before throwing.
Input / Data:      A route that takes ~2s of processing before throwing an error.
Steps:             1. Note client-side request-sent time T0. 2. Trigger the delayed error. 3. Compare response timestamp to T0.
Expected result:   Response timestamp ≈ T0+2s (when the exception was actually caught/rendered), not T0 — confirms it's computed at response-write time, not stamped earlier in the pipeline.
Notes:             Minor, but useful for log-correlation accuracy under any handler with meaningful processing time.
```

### 3.5 Interceptors & middleware (request-id, response envelope, request-context, subscription-headers, body limits, timeout)

```
ID / Title:        MID-001 — RequestIdMiddleware generates a fresh UUID when no client header is supplied
Area:              happy
Criticality:       High
Traces to:         request-id.middleware.ts
Preconditions:     None.
Input / Data:      A request with no X-Request-Id header.
Steps:             1. Send any request without the header.
Expected result:   Response includes an x-request-id header containing a valid UUID (v4 format); the same value appears in any error/success envelope's requestId field.
Notes:             Baseline.
```

```
ID / Title:        MID-002 — a safe client-supplied X-Request-Id is preserved verbatim
Area:              happy / rule
Criticality:       High
Traces to:         request-id.middleware.ts SAFE_REQUEST_ID regex `^[A-Za-z0-9_-]{1,128}$`
Preconditions:     None.
Input / Data:      X-Request-Id: mobile-ios-9f3a2b1c-retry-2.
Steps:             1. Send a request with this header.
Expected result:   Response's x-request-id echoes 'mobile-ios-9f3a2b1c-retry-2' exactly — enables cross-service trace correlation as intended.
Notes:             Confirms allowed characters include dash and underscore, per the regex.
```

```
ID / Title:        MID-003 — an unsafe/oversized client-supplied X-Request-Id is replaced, never trusted verbatim
Area:              negative / boundary
Criticality:       Critical
Traces to:         request-id.middleware.ts comment — log-injection / unbounded-length defense
Preconditions:     None.
Input / Data:      Try each independently: (a) X-Request-Id containing a newline: "abc\r\nX-Injected: evil", (b) a 200-character alphanumeric string (exceeds the 128 cap), (c) X-Request-Id: "../../etc/passwd" (path-like), (d) an emoji/unicode value, (e) an empty string header.
Steps:             1. Send each variant as a separate request.
Expected result:   In every case, the middleware discards the supplied value and generates a fresh UUID instead — none of the unsafe values ever appear in the response header, logs, or downstream requestId fields.
Notes:             (a) is the log-injection case explicitly called out in the code comment — must be verified directly, not assumed from reading the regex (confirm CRLF is actually rejected by testing, since some HTTP client libraries silently strip/reject CRLF in header values before the app even sees them — verify at the raw socket/curl level to rule that out as a false negative).
```

```
ID / Title:        MID-004 — X-Request-Id boundary: exactly 128 chars accepted, 129 chars rejected
Area:              boundary
Criticality:       Medium
Traces to:         request-id.middleware.ts regex `{1,128}`
Preconditions:     None.
Input / Data:      A 128-char alphanumeric string; a 129-char alphanumeric string; a 0-length (empty) string.
Steps:             1. Send each as X-Request-Id.
Expected result:   128-char value: preserved verbatim. 129-char value: replaced with a generated UUID. Empty string: replaced with a generated UUID (regex requires {1,...}, zero-length doesn't match).
Notes:             Classic off-by-one boundary — test all three explicitly.
```

```
ID / Title:        MID-005 — ResponseInterceptor wraps a normal success payload in the standard envelope
Area:              happy
Criticality:       High
Traces to:         response.interceptor.ts
Preconditions:     A route WITHOUT @SkipTransform().
Input / Data:      A successful GET returning e.g. { id:'...', name:'...' }.
Steps:             1. Call the route.
Expected result:   Body is { success:true, statusCode:200, message:'Success', data:{id:...,name:...}, requestId:'<uuid>', timestamp:'<ISO>' } — the original payload is nested under `data`, not merged into the top level.
```

```
ID / Title:        MID-006 — a handler returning undefined/void (e.g. a 204 No Content) renders data:null, not data:undefined
Area:              boundary (empty/null)
Criticality:       Medium
Traces to:         response.interceptor.ts:51 `data: data ?? null`
Preconditions:     A route like POST /api/auth/mobile/logout (@HttpCode(204), returns Promise<void>).
Input / Data:      Call logout.
Steps:             1. Call the logout endpoint.
Expected result:   If the envelope is even applied to a 204 (verify: many API conventions suppress the body entirely on 204 — confirm whether Nest's response pipeline actually invokes the interceptor's map() and writes a body on a 204, or whether Express/Nest suppresses it) — if a body is written, data must be null, never the literal string "undefined" or a missing key.
Notes:             204 + a JSON body is technically non-conformant per HTTP semantics (204 should have no body) — worth explicitly confirming what actually happens on the wire (curl -i) rather than just the JS-level return value, since a `res.statusCode=204` response with a body is a real spec violation some HTTP clients handle inconsistently.
```

```
ID / Title:        MID-007 — @SkipTransform() bypasses the envelope entirely, handler-level override wins over class-level
Area:              rule
Criticality:       High
Traces to:         response.interceptor.ts:32-36 Reflector.getAllAndOverride, SKIP_TRANSFORM_KEY
Preconditions:     A sync-module route with @SkipTransform() (per the decorator's own doc comment referencing sync-engine.md §2).
Input / Data:      Call a sync endpoint that returns e.g. { changes:[...], sync_cursor:'...' }.
Steps:             1. Call the route.
Expected result:   Response body is exactly { changes:[...], sync_cursor:'...' } at the top level — NOT wrapped in {success,data,...}.
Notes:             Also test a hypothetical class with @SkipTransform() at the controller level and one handler explicitly NOT overriding it back on — handler wins when explicitly set, per getAllAndOverride semantics (handler metadata checked first) — if any handler needs the envelope despite a class-level skip, verify that override actually works (would need a real or synthetic test controller).
```

```
ID / Title:        MID-008 — RequestContextInterceptor populates ALS for authenticated requests; getUserId()/getStoreId() resolve correctly downstream
Area:              happy
Criticality:       Critical
Traces to:         request-context.interceptor.ts, request-context.service.ts
Preconditions:     A route behind MobileJwtGuard + a store-context guard (req.context populated).
Input / Data:      An authenticated request to a store-scoped route.
Steps:             1. Call the route. 2. In the handler/a downstream service, call RequestContextService.getUserId()/getStoreId()/getAccountId()/getRequestId()/getIp()/getUserAgent().
Expected result:   All values match the actual authenticated principal, the resolved store/account context, the request's x-request-id, the caller's real IP (trust-proxy-derived), and the User-Agent header — resolvable from arbitrarily deep in the call stack with no parameter threading.
```

```
ID / Title:        MID-009 — RequestContextInterceptor is skipped (no ALS) for @Public() routes with no req.user
Area:              rule
Criticality:       High
Traces to:         request-context.interceptor.ts:30 `if (!principal) return next.handle();`
Preconditions:     A @Public() route with no auth guard populating req.user (e.g. login/otp).
Input / Data:      Call login/otp.
Steps:             1. Call the route. 2. Inside the handler (or a service it calls), call RequestContextService.getContext().
Expected result:   getContext() returns undefined (no ALS was established) — any code on this path that calls getOrThrow() will throw the plain Error "No request context — called outside a request scope", surfacing as a 500/internal_error via the generic filter branch (not a typed 401/403).
Notes:             This is a meaningful behavioral gotcha: any future refactor that adds a getOrThrow() call reachable from a Public route would silently start 500ing on that route — worth an explicit regression test pinning "public routes get NO request context" as intended behavior, not an oversight to be revisited.
```

```
ID / Title:        MID-010 — RequestContextInterceptor propagates client disconnect/unsubscribe to the inner handler
Area:              failure/recovery
Criticality:       Medium
Traces to:         request-context.interceptor.ts:59 `return () => subscription?.unsubscribe();`
Preconditions:     A long-running handler (e.g. artificially delayed) that would otherwise keep running after the client disconnects.
Input / Data:      A slow endpoint; client aborts the connection mid-request.
Steps:             1. Start a request to a slow handler. 2. Abort the client connection before it completes (e.g. close the socket / cancel the fetch).
Expected result:   The inner subscription is torn down (verify via a spy/log in the handler's observable chain, or verify no orphaned DB query continues running to completion after the abort, if the handler's chain is cancellable) — the outer teardown callback actually reaches the inner `next.handle()` subscription, not just the interceptor's own Observable wrapper.
Notes:             This addresses a real class of bug (resource leak / wasted DB work on abandoned requests) the code comment explicitly documents as the reason for manual Subscription plumbing rather than a bare passthrough.
```

```
ID / Title:        MID-011 — SubscriptionHeadersInterceptor emits both headers when freshness + warning are present
Area:              happy
Criticality:       Medium
Traces to:         subscription-headers.interceptor.ts
Preconditions:     A route behind a subscription-status guard that stamps req.subscriptionFreshness = {version:7, warning:'past_due:grace_until_2026-07-15T00:00:00.000Z'} (a past-due account within grace).
Input / Data:      Call such a route.
Steps:             1. Call the route. 2. Inspect response headers.
Expected result:   X-Subscription-Version: 7, X-Subscription-Warning: past_due:grace_until_2026-07-15T00:00:00.000Z both present.
```

```
ID / Title:        MID-012 — SubscriptionHeadersInterceptor emits only the version header when there's no warning
Area:              boundary
Criticality:       Low
Traces to:         subscription-headers.interceptor.ts:37-39 `if (freshness.warning) {...}`
Preconditions:     req.subscriptionFreshness = {version:7} (no warning — healthy subscription).
Input / Data:      Call such a route.
Steps:             1. Call the route. 2. Inspect headers.
Expected result:   X-Subscription-Version: 7 present; X-Subscription-Warning absent entirely (not present-but-empty).
```

```
ID / Title:        MID-013 — SubscriptionHeadersInterceptor is a no-op when the guard never ran (no req.subscriptionFreshness)
Area:              rule (negative)
Criticality:       Medium
Traces to:         subscription-headers.interceptor.ts:35 `if (!freshness || res.headersSent) return;`
Preconditions:     A public/no-store route where SubscriptionStatusGuard never runs.
Input / Data:      Call e.g. login/otp.
Steps:             1. Call the route. 2. Inspect headers.
Expected result:   Neither X-Subscription-Version nor X-Subscription-Warning appears — confirms the interceptor doesn't fabricate defaults for routes carrying no account context.
```

```
ID / Title:        MID-014 — SubscriptionHeadersInterceptor doesn't crash if headers were already sent (e.g. after the 30s timeout fired)
Area:              failure/recovery
Criticality:       Medium
Traces to:         subscription-headers.interceptor.ts:35 `res.headersSent` guard
Preconditions:     A handler that runs past the 30s hard timeout (apply-global-config.ts's raw middleware already wrote a 408 response and headers).
Input / Data:      A deliberately slow handler (>30s) on a subscription-guarded route.
Steps:             1. Trigger the 30s timeout. 2. Let the original handler eventually complete anyway (if it's not truly killed).
Expected result:   No unhandled "Cannot set headers after they are sent to the client" exception/crash — the interceptor's headersSent check prevents it; the eventual (now-irrelevant) handler completion is silently discarded from the client's perspective (client already received the 408).
Notes:             Directly tests the interaction between two different infra pieces (the ad-hoc timeout middleware and this interceptor) — a real integration seam, not just a unit-level check.
```

```
ID / Title:        MID-015 — 30-second hard timeout fires and returns its own non-standard 408 envelope
Area:              failure/recovery
Criticality:       High
Traces to:         apply-global-config.ts req.setTimeout(30_000, ...)
Preconditions:     A handler that takes longer than 30s (simulate with an artificial delay, or a genuinely slow downstream dependency).
Input / Data:      Call a route with a >30s artificial delay injected.
Steps:             1. Call the route. 2. Wait for the timeout to fire. 3. Inspect the response.
Expected result:   408, body { success:false, statusCode:408, message:'Request timeout', errorCode:'REQUEST_TIMEOUT' } — note: errorCode is UPPERCASE here (unlike every AllExceptionsFilter-routed error, which lowercases it), and the body has NO requestId and NO timestamp fields, unlike every other error path in the app.
Notes:             This is a genuine, verifiable inconsistency in the current implementation (this response bypasses AllExceptionsFilter entirely) — confirm exactly as coded, then raise as an open question (§7) on whether client code that expects requestId/timestamp/lowercase errorCode on EVERY error response needs a defensive fallback for this one path, or whether this path should be unified with the standard filter.
```

```
ID / Title:        MID-016 — a request just under 30s completes normally, not affected by the timeout setup
Area:              boundary
Criticality:       Medium
Traces to:         apply-global-config.ts req.setTimeout(30_000, callback) — Node's req.setTimeout only fires the callback, doesn't itself abort if the response completes first.
Preconditions:     A handler taking ~29s.
Input / Data:      Call a route with a 29s artificial delay.
Steps:             1. Call the route.
Expected result:   Completes normally at ~29s with its real success/error response — the 30s callback never fires because the response was already sent, and Node clears the underlying socket timeout on `res.end()`.
Notes:             Confirms no race where a response completing at 29.9s still gets clobbered by a timeout callback scheduled at 30.0s.
```

```
ID / Title:        MID-017 — oversized JSON body is rejected before reaching any guard/pipe/handler
Area:              negative / boundary
Criticality:       High
Traces to:         apply-global-config.ts useBodyParser('json', {limit: env.JSON_BODY_LIMIT}) — default '1mb' (env.ts:50)
Preconditions:     None (default JSON_BODY_LIMIT).
Input / Data:      A POST body of exactly 1MB+1 byte of valid JSON to any JSON-accepting route.
Steps:             1. Send the oversized payload.
Expected result:   413 Payload Too Large (Express/body-parser's own error, which propagates through Nest's exception handling) — confirm it's still rendered through AllExceptionsFilter's generic HttpException path with a sane errorCode (verify exactly what errorCode/status this becomes — body-parser errors have `status`/`statusCode` 413 and a `type` like 'entity.too.large'; confirm classifyHttpException's branches handle this body shape sensibly rather than falling through unexpectedly).
Notes:             Also test exactly at the 1MB boundary (should succeed) and 1 byte under (should succeed) — precise boundary test, not just "very large fails."
```

```
ID / Title:        MID-018 — a body at or under the JSON_BODY_LIMIT boundary succeeds
Area:              boundary
Criticality:       Medium
Traces to:         same as MID-017
Preconditions:     None.
Input / Data:      A body of exactly 1,048,576 bytes (1MB) of valid JSON matching some accepting endpoint's schema shape as closely as possible.
Steps:             1. Send the exactly-1MB body.
Expected result:   Accepted (200/201/whatever the route normally returns) — not rejected purely for size at the boundary.
```

```
ID / Title:        MID-019 — TrimStringPipe runs before ValidationPipe so whitespace-only required fields are correctly rejected
Area:              rule
Criticality:       High
Traces to:         apply-global-config.ts comment: "TrimStringPipe must come before ValidationPipe so @IsNotEmpty() sees already-trimmed values"; trim-string.pipe.ts — empty string after trim becomes null
Preconditions:     A DTO field with @IsNotEmpty() (class-validator) — find a real one, or a Zod schema with .min(1).
Input / Data:      A request body with that field set to "   " (three spaces only).
Steps:             1. Send the request.
Expected result:   422/VALIDATION_FAILED — the field is treated as effectively empty/missing (trimmed to null, then failing the not-empty/required check), NOT accepted as a valid non-empty string.
Notes:             This is the exact scenario the pipe ordering comment calls out — verify the ORDER matters by also confirming (via code reading, not necessarily re-testing) that reversing the order would let "   " slip through IsNotEmpty (which doesn't consider whitespace-only as empty by default in class-validator) — this test proves the current order prevents that.
```

```
ID / Title:        MID-020 — TrimStringPipe recursively trims nested object fields, not just top-level
Area:              rule
Criticality:       Medium
Traces to:         trim-string.pipe.ts trimObject() recursion
Preconditions:     A DTO with a nested object, e.g. { device: { model: '  Pixel 7  ' } }.
Input / Data:      POST with device.model = "  Pixel 7  ".
Steps:             1. Send the request. 2. Inspect what the handler/service actually receives (or the persisted value).
Expected result:   device.model is stored/used as "Pixel 7" (trimmed), not "  Pixel 7  ".
Notes:             Also verify an empty-after-trim nested field (e.g. device.model: "   ") becomes null, not "" — per trim-string.pipe.ts:6 `v.trim() || null`.
```

### 3.6 Pagination

```
ID / Title:        PAG-001 — first page (no cursor) returns the newest `limit` rows in DESC order
Area:              happy
Criticality:       High
Traces to:         paginate.ts paginateByCursor() — keyset undefined path
Preconditions:     >20 rows exist for a paginated resource (e.g. sessions list).
Input / Data:      GET /api/auth/mobile/sessions?limit=10 (no cursor).
Steps:             1. Call the endpoint.
Expected result:   Exactly 10 rows, newest-first (by the underlying sort column DESC), has_more:true, next_cursor: a non-null opaque string.
```

```
ID / Title:        PAG-002 — following next_cursor returns the next page with no overlap and no gap
Area:              happy
Criticality:       Critical
Traces to:         paginate.ts keyset predicate
Preconditions:     >20 rows, page size 10.
Input / Data:      Page 1 (no cursor), then page 2 (cursor = page 1's next_cursor).
Steps:             1. Fetch page 1. 2. Fetch page 2 using its cursor.
Expected result:   Page 2's rows are exactly the next 10 rows after page 1's last row — no row appears in both pages, no row is skipped between them.
```

```
ID / Title:        PAG-003 — last page reports has_more:false and next_cursor:null
Area:              happy / boundary
Criticality:       High
Traces to:         paginate.ts:71-75 `hasMore = rows.length > limit`
Preconditions:     Exactly 25 rows, limit=10.
Input / Data:      Fetch page 1, page 2, page 3.
Steps:             1. Fetch all 3 pages in sequence.
Expected result:   Page 3 has 5 rows, has_more:false, next_cursor:null.
```

```
ID / Title:        PAG-004 — exactly `limit` rows remaining (limit+1 boundary) correctly reports has_more:false, not a false-positive extra page
Area:              boundary
Criticality:       Critical
Traces to:         paginate.ts:71 `hasMore = rows.length > limit` (strictly greater — fetches limit+1 to probe)
Preconditions:     Exactly 20 rows total, limit=10; page 1 already consumed 10, exactly 10 remain for page 2.
Input / Data:      Fetch page 2 with cursor from page 1.
Steps:             1. Fetch page 2.
Expected result:   Page 2 returns exactly 10 rows, has_more:false, next_cursor:null — the fetch of limit+1=11 rows returns only 10 (nothing left), so hasMore correctly evaluates false. This is the precise off-by-one this "fetch N+1" pattern exists to get right.
```

```
ID / Title:        PAG-005 — empty result set (zero rows) returns an empty page, not an error
Area:              boundary (empty)
Criticality:       Medium
Traces to:         paginate.ts — no special-casing needed, but verify no exception on rows.length===0
Preconditions:     A user/store with zero rows for the paginated resource (e.g. a brand-new user with no sessions besides the current one, if that's excludable, or any genuinely empty list endpoint).
Input / Data:      GET the list endpoint.
Steps:             1. Call the endpoint.
Expected result:   200, { data:[], next_cursor:null, has_more:false } — not a 404, not a 500, not `data: null`.
```

```
ID / Title:        PAG-006 — decodeCursor rejects a malformed cursor with 400 INVALID_CURSOR (not a 500)
Area:              negative
Criticality:       High
Traces to:         cursor.ts:20-30 decodeCursor() catch → BadRequestError(INVALID_CURSOR)
Preconditions:     None.
Input / Data:      cursor=not-valid-base64url!!!, cursor=<base64url of "not json">, cursor=<base64url of '{"id":123,"v":456}'> (wrong types — numbers instead of strings), cursor=<base64url of '{"id":"x"}'> (missing v).
Steps:             1. Send each variant as the cursor query param.
Expected result:   Every variant → 400, errorCode:'invalid_cursor', message:"The pagination cursor is invalid" — never a 500, never a silently-wrong page.
Notes:             Four distinct malformation modes in one case family — test all four, not just one, since each exercises a different line (Buffer.from/JSON.parse throwing vs. the explicit typeof checks).
```

```
ID / Title:        PAG-007 — a cursor from a different resource/endpoint (wrong shape context, same {id,v} shape) is accepted structurally but yields nonsensical/empty results, not a crash
Area:              negative / cross-cutting
Criticality:       Medium
Traces to:         cursor.ts — the cursor format is generic; nothing ties it to a specific resource/query.
Preconditions:     Two different paginated endpoints both using this shared cursor helper (e.g. sessions list and some other cursor-paginated list).
Input / Data:      Take a valid next_cursor from endpoint A, submit it as the cursor to endpoint B.
Steps:             1. Get a valid cursor from list A. 2. Call list B with that cursor.
Expected result:   No crash — decodeCursor() succeeds (shape is valid), and the keyset predicate is applied against B's (semantically unrelated) sort/tie columns; result is likely an empty or unexpectedly-filtered page, but never a 500 or cross-tenant data leak.
Notes:             This is a real cross-cutting risk worth flagging: the cursor carries no endpoint/resource identity or signature, so a client bug (or malicious client) reusing a cursor across endpoints is silently "handled" rather than rejected — confirm whether this is an accepted risk (cursors aren't meant to be portable, so a wrong result is the client's own bug) or whether a resource-scoped cursor signature should be added (§7).
```

```
ID / Title:        PAG-008 — clampLimit: non-numeric, NaN, and Infinity all fall back to the default
Area:              boundary / negative
Criticality:       High
Traces to:         paginated-response.ts:17-19 `if (!Number.isFinite(n) || n<=0) return def;`
Preconditions:     None.
Input / Data:      limit=abc, limit=NaN, limit=Infinity, limit= (empty string), limit=[] (array-shaped query param, if the framework allows it), limit not provided at all.
Steps:             1. Call clampLimit(raw) for each input (unit-level) or via the actual query param at the HTTP layer.
Expected result:   All return the default (20, unless overridden by the caller) — no NaN ever reaches a SQL LIMIT clause.
```

```
ID / Title:        PAG-009 — clampLimit: zero and negative values fall back to default, not clamped to 1
Area:              boundary
Criticality:       High
Traces to:         paginated-response.ts:18 `n <= 0` check
Preconditions:     None.
Input / Data:      limit=0, limit=-1, limit=-1000.
Steps:             1. Call clampLimit for each.
Expected result:   All return the default (20) — confirms 0/negative isn't clamped up to 1, it falls all the way back to the default page size.
```

```
ID / Title:        PAG-010 — clampLimit: a value between 0 and 1 exclusive (e.g. 0.5) falls back to default, not floored to 0
Area:              boundary (decimals)
Criticality:       Medium
Traces to:         paginated-response.ts:18-19 — the `n<=0` check happens BEFORE Math.floor, using the raw Number(raw) value.
Preconditions:     None.
Input / Data:      limit=0.5.
Steps:             1. Call clampLimit(0.5).
Expected result:   Returns the default (20) — NOT 0 (which is what Math.floor(0.5) would give if the order were reversed). Confirms the `n<=0` guard operates on the un-floored value.
Notes:             A genuinely subtle ordering-dependent boundary — worth pinning explicitly since a naive refactor (floor-then-check) would silently change 0.5's behavior from "default" to "zero rows requested."
```

```
ID / Title:        PAG-011 — clampLimit: a decimal above 1 is floored, not rounded
Area:              boundary (decimals)
Criticality:       Medium
Traces to:         paginated-response.ts:19 `Math.min(Math.floor(n), max)`
Preconditions:     None.
Input / Data:      limit=10.9.
Steps:             1. Call clampLimit(10.9).
Expected result:   Returns 10 (floored), not 11 (rounded) and not rejected.
```

```
ID / Title:        PAG-012 — clampLimit: value exactly at max is preserved; value over max is capped exactly at max
Area:              boundary
Criticality:       High
Traces to:         paginated-response.ts:19 `Math.min(..., max)` — default max=100
Preconditions:     None.
Input / Data:      limit=100, limit=101, limit=100000, limit=999999999999 (very large).
Steps:             1. Call clampLimit for each.
Expected result:   100→100, 101→100, 100000→100, 999999999999→100 — no overflow/precision issue even for very large inputs (Number.isFinite still true for large-but-finite numbers, so they're floored/capped normally, not treated as invalid).
```

```
ID / Title:        PAG-013 — a caller-supplied custom {def,max} overrides the built-in default correctly
Area:              rule
Criticality:       Low
Traces to:         paginated-response.ts clampLimit(raw, {def,max})
Preconditions:     A call site using non-default bounds (grep for actual usages — if none currently override the defaults, note this as untested-in-production and test at the unit level only).
Input / Data:      clampLimit(undefined, {def:50, max:200}), clampLimit(500, {def:50, max:200}).
Steps:             1. Call with the custom bounds.
Expected result:   undefined→50, 500→200 — confirms the options object genuinely overrides, isn't ignored.
```

```
ID / Title:        PAG-014 — millisecond-precision cursor doesn't strand a row sharing the same millisecond but different microsecond precision
Area:              boundary (decimals/rounding) — the exact scenario the date_trunc fix addresses
Criticality:       Critical
Traces to:         paginate.ts:53-66 comment block on timestamp precision
Preconditions:     Two rows whose sortColumn values share the same millisecond but differ in sub-millisecond (microsecond) precision — e.g. insert two rows within the same DB transaction/statement such that Postgres assigns them timestamps like 2026-07-08T10:00:00.123456+00 and 2026-07-08T10:00:00.123789+00 (same ms, different µs).
Input / Data:      Fetch a page ending exactly at the first of these two rows (cursor.v = "2026-07-08T10:00:00.123Z", the ms-truncated JS value).
Steps:             1. Seed two such rows. 2. Page through with a cursor landing exactly at the ms boundary they share. 3. Fetch the next page.
Expected result:   Both rows are eventually returned across the two pages, with no row silently and permanently skipped — the date_trunc('milliseconds', ...) comparison in the keyset predicate treats both rows as sharing the same v for comparison purposes, so the tieColumn (id) correctly orders/includes them instead of one falling into neither `<` nor `=` and vanishing from all future pages.
Notes:             This is the single highest-value pagination test in the whole suite — it's explicitly the bug class this code was written to prevent, per its own extensive comment. A regression here (e.g. removing the date_trunc) would be a silent, hard-to-notice data-loss-from-the-client's-perspective bug (the row still exists in the DB, it would just never appear in any paginated response again).
```

```
ID / Title:        PAG-015 — concurrent insert of a new "newest" row while a client is mid-pagination doesn't duplicate or skip existing rows
Area:              concurrency
Criticality:       High
Traces to:         keyset pagination's core guarantee vs. offset pagination's known weakness
Preconditions:     A stable sorted list of N rows; a client has fetched page 1.
Input / Data:      Insert a new row (which will sort as the newest, ahead of page 1) between fetching page 1 and page 2.
Steps:             1. Fetch page 1. 2. Insert a new row that would sort before all of page 1's rows. 3. Fetch page 2 using page 1's cursor.
Expected result:   Page 2 contains the correct next rows following page 1's last row — completely unaffected by the new insert at the front, since the keyset predicate is relative to the cursor's row values, not a row offset. No duplicate, no skip.
Notes:             This is the exact concurrency property offset-based (LIMIT/OFFSET) pagination famously gets wrong — worth an explicit side-by-side comment/assertion in the test that this is the property being verified.
```

```
ID / Title:        PAG-016 — concurrent delete of a row the client already has cursor'd past doesn't break the next page
Area:              concurrency
Criticality:       High
Traces to:         keyset predicate is relative to cursor value/id, not row position.
Preconditions:     Same as PAG-015.
Input / Data:      Delete one of page 1's already-returned rows, then fetch page 2.
Steps:             1. Fetch page 1. 2. Delete one of page 1's rows (not the last one). 3. Fetch page 2 with page 1's cursor.
Expected result:   Page 2 is correct and complete — the deletion of an earlier row doesn't shift/duplicate/skip anything in page 2, since the predicate only cares about the cursor's own (v,id), not a row count/offset.
```

```
ID / Title:        PAG-017 — deleting the exact row the cursor points to still allows correct continuation
Area:              edge (state edge — acting on a record that changed since load)
Criticality:       Medium
Traces to:         keyset predicate uses the cursor's stored (v,id) values directly, not a live lookup of that row.
Preconditions:     Page 1 fetched, cursor derived from its last row R.
Input / Data:      Delete row R itself (the exact row the cursor's id/v refer to), then fetch page 2.
Steps:             1. Fetch page 1 (cursor points at row R). 2. Delete row R. 3. Fetch page 2 with the cursor.
Expected result:   Page 2 still returns correctly — the predicate `(sortColumn,tieColumn) < (cursor.v, cursor.id)` doesn't require R to still exist; it's a pure value comparison, not a foreign-key/join lookup on R.
Notes:             Confirms the design decision (comparing against the cursor's carried values, not re-fetching row R) genuinely delivers the resilience-to-concurrent-deletes it's designed for — verify, don't just trust the code comment.
```

```
ID / Title:        PAG-018 — a single-row result set (first-run/degenerate case) paginates correctly
Area:              boundary (single item, first-run)
Criticality:       Low
Traces to:         paginate.ts general logic at n=1
Preconditions:     Exactly 1 row exists.
Input / Data:      GET the list with limit=20 (default).
Steps:             1. Call the endpoint.
Expected result:   { data:[<the one row>], next_cursor:null, has_more:false }.
```

```
ID / Title:        PAG-019 — cursor is genuinely opaque (not human-parseable/guessable) and round-trips exactly
Area:              rule (security-adjacent)
Criticality:       Low
Traces to:         cursor.ts encodeCursor/decodeCursor — base64url of JSON, no encryption/HMAC.
Preconditions:     None.
Input / Data:      A returned next_cursor value.
Steps:             1. Base64url-decode a real next_cursor value client-side. 2. Inspect the plaintext.
Expected result:   Decodes to readable JSON `{"id":"<uuid>","v":"<ISO date>"}` — confirms it's obfuscated (not casually human-typeable) but NOT cryptographically opaque/tamper-proof; a client (or attacker) CAN construct an arbitrary cursor with any id/v they choose (see PAG-007's related risk) since there's no signature/HMAC over the cursor contents.
Notes:             Not necessarily a bug (pagination cursors don't always need tamper-resistance if the underlying query is still scoped by the same authorization filters as page 1), but confirm: does the underlying `fetch()` callback re-apply the caller's authorization/tenant scoping on every page, independent of cursor contents? If yes, a forged cursor can at most see a wrong page of the client's OWN already-authorized data, not another tenant's — verify this explicitly since it's the actual security-relevant question, not the cursor's opacity itself.
```

### 3.7 Request-context service

```
ID / Title:        CTX-001 — getUserId/getStoreId/getAccountId/getRequestId/getIp/getUserAgent all resolve correctly within a request
Area:              happy
Criticality:       High
Traces to:         request-context.service.ts getters
Preconditions:     An authenticated, store-scoped request.
Input / Data:      Any such request.
Steps:             1. Call the endpoint; inside a deeply-nested service call (no context object passed as a parameter), call each getter.
Expected result:   Each getter returns the correct value for that specific in-flight request.
```

```
ID / Title:        CTX-002 — getOrThrow() throws when called outside any request (e.g. from a cron job)
Area:              rule (negative)
Criticality:       High
Traces to:         request-context.service.ts:34-38
Preconditions:     A scheduled/cron service (e.g. subscription-lifecycle-cron.service.ts) that does NOT run inside RequestContextInterceptor's ALS wrapper.
Input / Data:      Invoke a code path from the cron job that calls RequestContextService.getOrThrow().
Steps:             1. Trigger the cron job (or directly call getOrThrow() outside a request context in a unit test).
Expected result:   Throws Error("No request context — called outside a request scope") — synchronously, immediately, not a silently-undefined principal used downstream.
Notes:             If any cron/background code path actually calls getOrThrow() (verify via grep), this is a real live bug risk — confirm no such call site exists, or if one does, that its caller catches this specific Error appropriately rather than crashing the whole scheduled job ungracefully.
```

```
ID / Title:        CTX-003 — concurrent requests from different users never leak context into each other (ALS isolation)
Area:              concurrency
Criticality:       Critical
Traces to:         AsyncLocalStorage semantics — request-context.service.ts storage
Preconditions:     Two different authenticated users.
Input / Data:      User A and User B send requests to the same slow endpoint at nearly the same time, interleaved (e.g. A starts, B starts before A finishes, A finishes, B finishes).
Steps:             1. Fire both requests concurrently with A's handler artificially delayed to overlap B's. 2. In each handler, log RequestContextService.getUserId() at multiple points during the delay.
Expected result:   A's handler always sees A's userId throughout its entire execution, never B's, and vice versa — even though both are interleaved on the same event loop. This is the fundamental guarantee AsyncLocalStorage is supposed to provide; explicitly verify it under real interleaving, not just sequential calls.
Notes:             The single most safety-critical test for this file — a leak here would mean one user's requests could be attributed to another user's audit/context (e.g. wrong storeId used for a query = cross-tenant data exposure).
```

```
ID / Title:        CTX-004 — the deprecated instance run() method merges onto an existing context rather than replacing it wholesale
Area:              rule / boundary
Criticality:       Medium
Traces to:         request-context.service.ts:24-30 (deprecated run(principal, fn))
Preconditions:     SnapshotRefreshInterceptor (the one documented caller) runs after RequestContextInterceptor has already established a context with requestId/ip/userAgent/storeId set.
Input / Data:      A request through a route using SnapshotRefreshInterceptor.
Steps:             1. Call such a route. 2. Verify getRequestId()/getIp()/getStoreId() still return the original values after SnapshotRefreshInterceptor's call to the deprecated run().
Expected result:   requestId/ip/storeId/accountId are preserved from the existing context (only `user` is swapped), per the `existing ? {...existing, user: principal} : ...` merge logic.
```

```
ID / Title:        CTX-005 — the deprecated run() called with NO pre-existing context falls back to empty requestId/ip/userAgent
Area:              boundary (empty)
Criticality:       Low
Traces to:         request-context.service.ts:27-28 the `: { user: principal, requestId:'', ip:'', userAgent:'' }` fallback branch
Preconditions:     Hypothetically call the deprecated run() with no ambient ALS context established yet (would require a caller that runs before RequestContextInterceptor, or standalone).
Input / Data:      Direct unit-level invocation.
Steps:             1. Call request-context.service.ts's instance run(principal, fn) with no ALS context active.
Expected result:   Inside fn, getRequestId()/getIp()/getUserAgent() all return '' (empty string), not undefined — confirms the fallback shape. Flag whether any current real call site can actually hit this branch (if SnapshotRefreshInterceptor always runs after RequestContextInterceptor in practice, this branch may be dead code in production — worth confirming ordering guarantees it never fires with empty context in reality).
```

```
ID / Title:        CTX-006 — get() returns undefined (not throw) when called outside a request context
Area:              boundary
Criticality:       Low
Traces to:         request-context.service.ts:33 `get(): storage.getStore()?.user`
Preconditions:     Outside any request scope.
Input / Data:      Call get() directly.
Steps:             1. Call get() from a non-request context (e.g. app bootstrap code, a cron job).
Expected result:   Returns undefined cleanly, no throw — contrast directly with getOrThrow() (CTX-002), which is the throwing variant. Confirms callers have a genuine choice between "safe optional access" and "fail loud," and that both behave as documented.
```

### 3.8 Redis infrastructure

```
ID / Title:        RDS-001 — a single shared Redis connection serves throttle storage, health checks, and caches simultaneously
Area:              happy / rule
Criticality:       Medium
Traces to:         redis.provider.ts, redis.module.ts @Global comment ("exactly one physical connection rather than one per consuming module")
Preconditions:     None.
Input / Data:      Concurrent traffic hitting throttled routes, /health, and any Redis-cache-backed route simultaneously.
Steps:             1. Generate mixed concurrent load across all three Redis-consuming subsystems. 2. Inspect actual open Redis connections (e.g. via CLIENT LIST on the Redis server).
Expected result:   Exactly one client connection from the app process (per replica), not three-plus — confirms the DI wiring (@Inject(REDIS) everywhere) actually resolves to the same instance, not accidental duplicate providers.
```

```
ID / Title:        RDS-002 — a connected-but-hung Redis command times out at 1500ms (commandTimeout), not left pending indefinitely
Area:              boundary / failure
Criticality:       High
Traces to:         redis.provider.ts commandTimeout: 1500
Preconditions:     Redis reachable but a specific command artificially delayed >1500ms (e.g. via a network-latency-injecting proxy).
Input / Data:      Any Redis-backed call (throttle increment, health PING, a cache read).
Steps:             1. Inject >1500ms latency. 2. Trigger a Redis-backed operation.
Expected result:   The ioredis client rejects the pending command at ~1500ms with a timeout error — the caller's try/catch (present in the throttle storage and typed-cache paths) handles it per that path's own documented fallback; verify the health indicator path specifically (RedisHealthIndicator has no explicit timeout handling beyond letting the ping() promise reject naturally into its own try/catch → HealthCheckError, i.e. reported as down — confirm this actually resolves within ~1.5s + a small margin, not hanging until the 30s HTTP-level timeout).
```

```
ID / Title:        RDS-003 — Redis connection failure logs via the 'error' listener and does not crash the Node process
Area:              failure/recovery
Criticality:       Critical
Traces to:         redis.provider.ts:28 `redis.on('error', ...)` comment: "Node's EventEmitter crashes the process on an 'error' event with no listener"
Preconditions:     Redis completely unreachable at app startup or mid-run.
Input / Data:      Start the app with an invalid REDIS_URL, or kill Redis mid-run.
Steps:             1. Point REDIS_URL at an unreachable host and start the app (or kill Redis after a healthy start). 2. Observe process behavior and logs.
Expected result:   The app process stays alive; repeated connection errors are logged ("Redis client error: <message>") at intervals per the retryStrategy (200ms, 400ms, ... capped at 5000ms between attempts); no unhandled exception crash.
Notes:             This is a basic-but-critical infra-resilience case — a regression here (e.g. someone removes the error listener during a refactor) would make ANY Redis blip an instant full-process crash across the fleet, a far worse outcome than the various fail-open/degrade behaviors this module is otherwise built around.
```

```
ID / Title:        RDS-004 — retryStrategy backs off linearly and caps at 5000ms between reconnect attempts
Area:              boundary
Criticality:       Low
Traces to:         redis.provider.ts:24 `retryStrategy: (times) => Math.min(times*200, 5000)`
Preconditions:     Redis down for an extended period (>25s so several retries occur).
Input / Data:      N/A — observational.
Steps:             1. Take Redis down. 2. Observe reconnect attempt timing over ~30s via logs/network capture.
Expected result:   Attempt intervals grow: ~200ms, ~400ms, ~600ms, ... capping at 5000ms and staying there — never a tight retry loop hammering a down Redis, never a runaway/unbounded backoff either.
```

```
ID / Title:        RDS-005 — RedisLifecycle drains the connection cleanly on SIGTERM, no dangling connection/socket
Area:              failure/recovery (graceful shutdown)
Criticality:       Medium
Traces to:         redis.provider.ts RedisLifecycle.onApplicationShutdown() → redis.quit()
Preconditions:     App running normally.
Input / Data:      SIGTERM sent to the process.
Steps:             1. Send SIGTERM. 2. Observe Redis server-side connection list before/after.
Expected result:   The app's Redis connection is cleanly closed (QUIT sent, socket closed) as part of shutdown — no orphaned connection lingering on the Redis server after the process exits.
```

```
ID / Title:        RDS-006 — readTypedCache returns null (not a throw) on a JSON parse failure
Area:              failure/recovery
Criticality:       Medium
Traces to:         typed-cache.ts:24-29 try/catch around JSON.parse
Preconditions:     A cache key exists but holds corrupted/non-JSON data (e.g. via a manual SET of garbage bytes, or simulating a partial write).
Input / Data:      SET the cache key to a non-JSON string, e.g. "{not valid json".
Steps:             1. Corrupt the cache value. 2. Call readTypedCache(redis, key, schema).
Expected result:   Returns null — the caller's normal cache-miss/rebuild-from-DB path runs; no exception propagates out of readTypedCache.
```

```
ID / Title:        RDS-007 — readTypedCache returns null when the cached JSON is valid but fails schema validation (stale shape after a deploy)
Area:              rule / failure-recovery
Criticality:       High
Traces to:         typed-cache.ts:31-32 `schema.safeParse(parsed)` → null on failure
Preconditions:     A cache entry written by an OLDER version of the app with a since-changed shape (e.g. a field renamed or removed in a schema migration), simulating a rolling deploy where old-TTL cache entries outlive the code change.
Input / Data:      A cached JSON value matching the OLD shape, read against the NEW Zod schema.
Steps:             1. Seed a cache entry with the old shape. 2. Deploy/simulate the new schema. 3. Call readTypedCache with the new schema against the old value.
Expected result:   Returns null (treated as a miss) rather than returning a wrongly-shaped object that would then cause a downstream TypeError/undefined-property-access bug. This is the exact production scenario (rolling deploy + live TTL) the function's doc comment says it exists to prevent.
Notes:             This is the highest-value test in the Redis section — verify it precisely by constructing a real "old shape vs new schema" mismatch, not just a totally-malformed value (RDS-006 covers that simpler case already).
```

```
ID / Title:        RDS-008 — readTypedCache on a genuine cache miss (key doesn't exist) returns null, indistinguishable from a corrupt/stale hit
Area:              boundary (empty/null)
Criticality:       Low
Traces to:         typed-cache.ts:21 `if (!raw) return null;`
Preconditions:     Key never set, or expired via TTL.
Input / Data:      A key with no value.
Steps:             1. Call readTypedCache for a nonexistent key.
Expected result:   Returns null. Confirms all three failure modes (true miss, parse failure, schema failure) are unified into the same null contract for the caller — verify this is documented/acceptable (it is, per the function's own comment) rather than the caller needing to distinguish "there was no cache" from "the cache was corrupt" (it can't, and per the design, doesn't need to).
```

```
ID / Title:        RDS-009 — readTypedCache with an empty-string cached value (not null, but falsy) is treated as a miss
Area:              boundary (edge — falsy-but-not-null)
Criticality:       Low
Traces to:         typed-cache.ts:21 `if (!raw) return null;` — `!raw` is also true for an empty string
Preconditions:     A cache key explicitly SET to "" (empty string).
Input / Data:      redis.set(key, "").
Steps:             1. Set the key to an empty string. 2. Call readTypedCache.
Expected result:   Returns null (treated as miss) — confirms the `!raw` check catches empty string too, not just Redis's null-on-missing-key return, since "" is falsy in JS.
```

```
ID / Title:        RDS-010 — connectTimeout (10s) bounds initial connection attempts at app startup when Redis is slow to accept
Area:              boundary
Criticality:       Low
Traces to:         redis.provider.ts connectTimeout: 10_000
Preconditions:     Redis reachable but the TCP handshake/auth artificially delayed beyond 10s.
Input / Data:      N/A — infra-level simulation.
Steps:             1. Inject >10s connection-establishment latency. 2. Start the app (or trigger a reconnect).
Expected result:   The connection attempt is abandoned at ~10s and retried per retryStrategy, rather than hanging indefinitely on a slow handshake.
```

```
ID / Title:        RDS-011 — health check's Redis PING and the throttle path's Redis EVAL don't block each other under the shared single connection
Area:              concurrency
Criticality:       Medium
Traces to:         Single shared ioredis connection (redis.module.ts comment) — ioredis pipelines/queues commands over one socket.
Preconditions:     Heavy throttle traffic (many EVALs in flight) concurrent with a /health request's PING.
Input / Data:      Sustained load generating frequent throttle checks, plus periodic /health polling.
Steps:             1. Generate sustained throttled-route traffic. 2. Concurrently poll /health repeatedly.
Expected result:   /health's PING still completes promptly (well under 1500ms) even under throttle-EVAL load — ioredis command queuing over the single connection doesn't starve the health check into false negatives under normal (non-pathological) load.
Notes:             If this ever fails under realistic load, it's a strong argument for a dedicated Redis connection for health checks — flag as a capacity/architecture question if observed, not just a bug.
```

---

## 4. Edge-case scenarios (§5 checklist, explicitly called out)

```
ID / Title:        EDGE-001 — Empty/zero: THROTTLE_GLOBAL_LIMIT=0 blocks every request on that throttler from the very first hit
(Area: boundary; Criticality: Low; see THR-018 — duplicated here per the checklist's explicit "zero" callout.)
```

```
ID / Title:        EDGE-002 — First-run: a brand-new deploy with an empty audit_logs table — first-ever audit row insert behaves identically to the 10,000th
Area:              first-run
Criticality:       Low
Traces to:         audit.service.ts — no special-casing for "first row," but worth a smoke check that indexes/sequences are created correctly by the migration before any row exists.
Steps:             1. On a freshly migrated, empty DB, log the very first audit entry.
Expected result:   Succeeds identically to steady-state; no "table not yet analyzed" or index-related first-insert failure.
```

```
ID / Title:        EDGE-003 — Maximum/overflow: a pagination limit request of Number.MAX_SAFE_INTEGER doesn't overflow or bypass the cap
Area:              boundary (maximum/overflow)
Criticality:       Medium
Traces to:         paginated-response.ts clampLimit — see PAG-012, restated here as the checklist's explicit "huge numbers" item.
Steps:             1. Request ?limit=9007199254740991.
Expected result:   Clamped to max (100), not passed through or causing a numeric overflow anywhere downstream (e.g. in a SQL LIMIT clause).
```

```
ID / Title:        EDGE-004 — Decimals & rounding: a throttle window's Reset header rounds via ceil, never reports 0s remaining while still actually blocked
Area:              decimals/rounding
Criticality:       Low
Traces to:         redis-throttler-storage.ts:48,63 `math.ceil(...)` for both timeToExpire and timeToBlockExpire.
Steps:             1. Inspect X-RateLimit-Reset / Retry-After at a moment with e.g. 400ms actually remaining.
Expected result:   Reported as 1 (ceil), never 0 or a fractional second — a client backing off based on this header never under-waits due to a rounding-down artifact.
```

```
ID / Title:        EDGE-005 — Duplicate/repeat: identical audit event logged twice in rapid succession for the same user/entity (e.g. a genuine double-click double-submit at the caller) produces two distinct rows, not a dedup/merge
Area:              duplicate/repeat
Criticality:       Medium
Traces to:         audit.service.ts log() — plain insert, no idempotency key, no upsert.
Steps:             1. Call auditService.log() twice with byte-identical entry content, back to back.
Expected result:   Two separate rows, two separate createdAt timestamps (however close) and two separate ids — the audit log is intentionally an append-only, non-deduplicated ledger; confirm this is the intended semantic (it should be, for a compliance trail) rather than assumed.
```

```
ID / Title:        EDGE-006 — Out-of-order: a response for request #1 completes AFTER a response for request #2 on the same connection/keep-alive socket — request-scoped context still isolates correctly
Area:              out-of-order
Criticality:       High
Traces to:         RequestContextService's AsyncLocalStorage is per-async-execution-context, not per-socket, so HTTP/1.1 response ordering shouldn't matter — but worth an explicit check given Node's shared event loop.
Steps:             1. Fire request #1 (slow handler) then request #2 (fast handler) on the same keep-alive connection, such that #2's response is written first. 2. Verify each response's data/requestId corresponds correctly to its own request, not swapped.
Expected result:   No cross-talk — #1's eventual response still carries #1's own requestId/data, #2's carries #2's, regardless of completion order.
```

```
ID / Title:        EDGE-007 — Concurrent identical: two devices (two logins) for the same user hitting login/verify at the exact same millisecond
Area:              concurrent identical
Criticality:       High
Traces to:         THR-015's general pattern, applied to a real business flow rather than a synthetic burst.
Steps:             1. Fire two truly concurrent login/verify calls for the same phone/OTP from two different devices/IPs.
Expected result:   Both are independently throttle-checked per (their own IP, this handler) — no shared-fate between the two devices' throttle buckets (different IPs); the underlying business logic (OTP single-use) is out of this file's scope, but confirm the throttle layer itself doesn't itself introduce a false block or a false pass due to the concurrency.
```

```
ID / Title:        EDGE-008 — Offline → sync: N/A directly to this infra (no offline queue in throttle/health/common), but the 30s hard-timeout + sync engine's own retry semantics interact — a mobile client that queued a mutation offline and replays it after reconnecting could hit the SAME idempotency concerns as a duplicate submit
Area:              offline→sync (cross-reference, not owned by this file)
Criticality:       Low
Notes:             Out of scope for this infra's own tests (idempotency-key handling lives in the sync/order modules), but flag the interaction: if a queued/replayed mutation arrives right as the 30s timeout fires on the FIRST attempt (client believes it failed, retries), the server may have actually completed the first attempt — this is a general at-least-once-delivery risk the 30s timeout amplifies. Recommend the sync/orders test suites explicitly cover "client retries after client-perceived timeout, server actually succeeded the first attempt" using idempotency keys — cross-reference here since the 30s middleware in THIS file is the trigger.
```

```
ID / Title:        EDGE-009 — Permission/subscription change mid-flow: X-Subscription-Warning header value format changes are handled by not being over-parsed by RequestContext/Response infra
Area:              permission/subscription change mid-flow
Criticality:       Low
Traces to:         subscription-headers.interceptor.ts just relays whatever string the guard produced.
Steps:             1. Confirm the interceptor performs zero parsing/validation of the warning string's format (`past_due:grace_until_<ISO>`) — it's opaque to this layer.
Expected result:   Any change to the warning string's format by the upstream guard requires no change to this interceptor — confirms proper separation of concerns (this infra is a dumb relay, not a business-rule owner). Not itself a bug-finding case, but worth confirming the boundary is where it's assumed to be.
```

```
ID / Title:        EDGE-010 — Abandonment/interruption: a client that sends a request then immediately closes the socket before headers are even sent back
Area:              abandonment/interruption
Criticality:       Medium
Traces to:         MID-010's disconnect-teardown case, applied at the earliest possible abandonment point (before any processing has meaningfully started).
Steps:             1. Open a connection, send a request, close the socket before the server can respond at all.
Expected result:   No unhandled promise rejection / crash on the server; the RequestContextInterceptor's teardown (`subscription?.unsubscribe()`) runs cleanly even when invoked almost immediately.
```

```
ID / Title:        EDGE-011 — Time: DST transition doesn't affect throttle window math (Redis TIME is UTC-based, not wall-clock-local)
Area:              time/timezone/DST
Criticality:       Low
Traces to:         redis-throttler-storage.ts uses Redis's `TIME` command (UTC epoch-based), not any local wall-clock — DST-immune by construction.
Steps:             1. Run a throttle test spanning a DST transition instant (or reason about it analytically given the TIME-based implementation, since forcing a real DST transition in a test window isn't practical).
Expected result:   Confirm no wall-clock/local-timezone arithmetic appears anywhere in redis-throttler-storage.ts (it doesn't — all math is on epoch milliseconds from Redis TIME) — DST transitions have zero effect on window/block timing.
```

```
ID / Title:        EDGE-012 — Time: clock skew between the app server and Redis server doesn't matter (Redis TIME is authoritative, not the app's Date.now())
Area:              time/clock skew
Criticality:       Medium
Traces to:         redis-throttler-storage.ts:39-40 `local t = redis.call('TIME')` — deliberately NOT using the app's own clock.
Steps:             1. Artificially skew the app server's system clock (e.g. +5 minutes) relative to Redis's. 2. Run a normal throttle sequence.
Expected result:   Throttle window/block timing is unaffected by the app-server skew — because all "now" calculations happen inside the Lua script against Redis's own TIME, not any value passed in from the app. This is exactly why the code comment says "Uses Redis TIME so all replicas share one clock" — confirm it also protects against app/Redis skew, not just inter-replica skew.
```

```
ID / Title:        EDGE-013 — Long/unusual input: a pathological User-Agent header (10KB string, or one containing control characters) doesn't break RequestContext, audit logging, or the request-id middleware
Area:              long/unusual input
Criticality:       Medium
Traces to:         request-context.interceptor.ts reads `req.headers['user-agent']` directly into context/audit with no length/content sanitization visible in this module.
Steps:             1. Send a request with a 10KB User-Agent header (if the HTTP server/Express even accepts headers that large — check header-size limits too) containing embedded control characters. 2. Trigger an audit-logged action (e.g. login).
Expected result:   Either the request is rejected upstream (Express/Node's own max-header-size limit, typically ~8-16KB total headers) before reaching this app code, OR it's accepted and the raw value is stored/relayed as-is in userAgent context/audit fields without crashing — confirm which, and if accepted, confirm no log-injection risk analogous to the one X-Request-Id explicitly guards against (this field has NO equivalent SAFE_REQUEST_ID-style sanitization applied anywhere in this module — flag as a potential gap, §7).
```

```
ID / Title:        EDGE-014 — State edge: a route decorated with both @Public() and reachable via a stale/cached JWT in a header anyway — RequestContextInterceptor's `req.user` check
Area:              state edge
Criticality:       Low
Traces to:         request-context.interceptor.ts:28-30 — checks req.user, not the route's @Public() decorator directly; if some other middleware/guard incidentally populates req.user even on a nominally-public route (e.g. an optional-auth guard pattern elsewhere in the app), context IS established.
Steps:             1. Send a request to a @Public() route WITH a valid Authorization header, on a route where some guard opportunistically decodes and attaches req.user even though auth isn't required.
Expected result:   Document the actual behavior: if req.user ends up populated by any means, RequestContextInterceptor WILL establish a context (its check is purely presence-of-req.user, agnostic to why). Confirm whether any current @Public() route's guard chain can produce this (grep for optional-auth patterns) — if so, that route gets full request-context/audit correlation despite being nominally anonymous, which is likely desirable (better audit trail) but should be a confirmed, not accidental, behavior.
```

---

## 5. Coverage summary

| Requirement / rule / transition | Satisfied case(s) | Violated / negative case(s) | Gap? |
|---|---|---|---|
| Global throttle limit (300/min default, per route+IP) | THR-001, THR-003 | THR-002 | None |
| Global throttle limit is env-configurable | THR-017 | THR-018 | None |
| Per-route stricter throttle overrides (login/signup OTP+verify) | THR-004, THR-005, THR-006 | THR-004 (6th req) | None |
| Throttle block window (60s, = ttl default) | THR-007, THR-008 | — | None |
| Throttle atomicity under concurrency | THR-015 | — | None |
| Throttle IP isolation (per client) | THR-013 | — | None |
| Throttle key scoping is per-(handler,IP) not truly global | THR-005, THR-006, THR-020 | — | **Open question §7 — confirm intended** |
| Throttle fails open on Redis outage | THR-009, THR-010, THR-011 | — | None |
| @SkipThrottle exemption (health, webhook) | THR-012 | — | None |
| Trust-proxy IP integrity underpinning the limiter | THR-014 | — | None |
| Health `/health` full check (db+redis+mem+disk) | HLT-001 | HLT-003, HLT-005, HLT-006, HLT-007, HLT-013 | None |
| Health `/health/live` ignores all dependencies | HLT-002 | — | None |
| Health `/health/ready` is DB-only, ignores Redis | HLT-004 | HLT-003 | None |
| Health endpoints unauthenticated + unthrottled | HLT-008, HLT-010 | — | None |
| Health routes excluded from /api prefix | HLT-009 | — | None |
| Audit log() default isSuccess=true | AUD-001 | — | None |
| Audit denial rows correctly flag isSuccess=false | — | AUD-002 | **Likely bug — flagged, needs dev confirmation** |
| Audit atomic-with-effect (login) | AUD-003, AUD-004 | — | None |
| Audit best-effort (RBAC denial) | AUD-005 | — | None |
| Audit actor vs subject distinction | AUD-006 | — | None |
| AppException status/code mapping | ERR-001, ERR-002 | — | None |
| Guard-pattern SCREAMING_SNAKE promotion | ERR-004, ERR-005 | ERR-009 (boundary) | None |
| Validation error shape (array + issues) | ERR-006, ERR-007 | — | None |
| Non-SCREAMING_SNAKE HttpException message → errorCode | — | ERR-008, ERR-011 | **Real inconsistency — flagged §7** |
| Postgres error → safe client mapping (23505/23503/23502/22P02/23514) | ERR-012–ERR-016 | ERR-017 (unmapped code) | None |
| Unknown exception → safe 500, no leak | — | ERR-018 | None |
| requestId/timestamp/errorCode-casing consistency | ERR-020, ERR-021, ERR-024 | MID-015 (30s-timeout bypass) | **Real inconsistency — flagged §7** |
| RequestId middleware accepts-safe/rejects-unsafe | MID-002 | MID-003, MID-004 | None |
| Response envelope wrap + SkipTransform bypass | MID-005, MID-007 | MID-006 (204 edge) | Needs confirmation of 204-body behavior |
| RequestContext ALS population + skip on Public | MID-008 | MID-009 | Documented as intended |
| Subscription headers conditional emission | MID-011, MID-012 | MID-013, MID-014 | None |
| 30s hard timeout | MID-015, MID-016 | — | Envelope-shape inconsistency flagged |
| Body size limit enforcement | MID-017, MID-018 | — | None |
| TrimStringPipe → ValidationPipe ordering | MID-019, MID-020 | — | None |
| Pagination: no skip/duplicate across pages (happy + concurrent insert/delete) | PAG-001–PAG-003, PAG-015–PAG-017 | — | None |
| Pagination: has_more off-by-one at exact limit boundary | PAG-004 | — | None |
| Pagination: cursor malformed → 400, never 500 | — | PAG-006 | None |
| Pagination: cursor portability across endpoints (no signature) | — | PAG-007, PAG-019 | **Open question §7** |
| Pagination: clampLimit boundaries (0, negative, decimal, NaN, huge) | PAG-011, PAG-012, EDGE-003 | PAG-008, PAG-009, PAG-010 | None |
| Pagination: ms/µs timestamp precision fix | PAG-014 | — | None (but highest-value regression risk) |
| RequestContext isolation under concurrency | CTX-003 | — | None |
| RequestContext getOrThrow vs get() contract | CTX-006 | CTX-002 | None |
| Redis fail-safe (error listener, timeouts, retry backoff) | RDS-001, RDS-004, RDS-005 | RDS-002, RDS-003 | None |
| Typed cache: miss/corrupt/schema-drift all → null | RDS-008, RDS-009 | RDS-006, RDS-007 | None |

**Gaps requiring product/dev confirmation before this suite can be called fully closed** (see §7 for full detail): the "global" throttle's actual per-route (not per-IP-wide) scoping; the audit `isSuccess` flag apparently not being set to `false` by the one caller (RBAC denial) whose own doc comment says it should be; the 403/404/etc. + `errorCode:internal_error` mismatch for plain-English `HttpException` messages; the 30-second timeout's non-standard, filter-bypassing error envelope; whether User-Agent header content gets any log-injection sanitization anywhere in the pipeline; whether pagination cursors need tamper-resistance beyond "re-scoped by the caller's own authorization on every page."

---

## 6. Priority roll-up (run these first)

**Critical:**
- THR-002, THR-003, THR-009, THR-015 (throttle enforcement + boundary + fail-open + atomicity)
- THR-014 (trust-proxy IP integrity — the limiter's entire IP-scoping depends on this)
- HLT-002, HLT-004 (liveness ignores deps; readiness ignores Redis specifically)
- HLT-013 (no credential/connection-string leak in health error messages)
- AUD-002 (isSuccess denial-flagging — likely bug, SOC2-relevant)
- AUD-003, AUD-004, AUD-005 (audit atomicity contracts — both directions)
- ERR-001, ERR-002, ERR-004 (status/code mapping — everything downstream depends on this)
- ERR-012, ERR-017, ERR-018 (no internals leak on any error class)
- MID-003 (X-Request-Id log-injection defense)
- MID-008, MID-009 (RequestContext correctness for the whole auth-dependent app)
- PAG-002, PAG-004, PAG-014 (pagination correctness — no skip/dup, the ms/µs precision fix specifically)
- CTX-003 (ALS cross-request isolation — a leak here is a cross-tenant data-exposure risk)
- RDS-003 (Redis error listener — a missing listener crashes the whole process on any blip)

**High:**
- THR-004, THR-005, THR-007, THR-008, THR-013 (per-route throttle behavior + block lifecycle)
- HLT-001, HLT-003, HLT-008 (full check + readiness-violated + auth bypass)
- ERR-006, ERR-007, ERR-008, ERR-013, ERR-015, ERR-020 (validation shape, the flagged inconsistency, PG mappings, requestId correlation)
- MID-001, MID-002, MID-007, MID-010, MID-015, MID-017, MID-019 (request-id happy path, envelope bypass, disconnect teardown, timeout inconsistency, body limit, pipe ordering)
- PAG-001, PAG-006, PAG-008, PAG-009, PAG-012, PAG-015, PAG-016 (core pagination correctness + boundaries + concurrency)
- CTX-001, CTX-002 (basic context contract)
- RDS-002, RDS-007 (Redis timeout behavior; typed-cache schema-drift safety — the exact production scenario it exists for)

Everything else (Medium/Low) should follow once the above are green — most Medium/Low cases are boundary refinements or documentation-of-current-behavior rather than pass/fail gates on production-readiness.

---

## 7. Open questions

1. **Is the "global" 300/min throttle intended to be one shared bucket per IP across ALL endpoints, or per-endpoint-per-IP (its actual current behavior)?** The module's doc-comment describes it as "Global per-IP throttler," but the default `generateKey` (`ClassName-HandlerName-ThrottlerName-IP`) scopes the counter per route. If a single shared IP-wide bucket was intended, `ThrottleModule` needs an explicit `generateKey` override; if per-route is intended (arguably more useful, since it prevents one noisy endpoint from starving all others for the same client), the doc comment should be corrected to avoid misleading future readers. Confirm with dev before treating THR-005/THR-006/THR-020's current behavior as "working as intended" vs. "needs a fix."

2. **Is it intentional that `PERMISSION_DENIED`/`SPECIAL_PERMISSION_DENIED` audit rows are recorded with `isSuccess: true`** (the default, since `permissions.guard.ts`'s `denyAudit()` doesn't appear to set `isSuccess: false` explicitly)? The field's own type comment says "false = denial (SOC2 CC6.3)," directly implying denial events should set it — if this is really unset, every compliance query filtering `WHERE is_success = false` would miss every permission denial, which seems like a meaningful audit-trail gap. Needs direct confirmation against the actual object literal at runtime (AUD-002) and a decision on whether to fix.

3. **Is it acceptable that a plain-English `HttpException` message (not SCREAMING_SNAKE, no explicit `errorCode`) always renders `errorCode: internal_error` regardless of the exception's real HTTP status** (e.g. a 403 rendering as `internal_error`)? This seems like an unintended consequence of the classification precedence rather than a deliberate design choice, since it actively misleads any client-side logic keying off `errorCode` rather than `statusCode`. Needs a decision: either (a) fall back to a status-derived generic code (e.g. `FORBIDDEN`/`NOT_FOUND`) instead of always `INTERNAL_ERROR` in this branch, or (b) confirm all call sites are expected to always use the guard-pattern/explicit-errorCode conventions, making this branch dead-in-practice (in which case, is it worth a lint rule enforcing that convention, rather than relying on this filter's silent fallback)?

4. **Should the 30-second hard-timeout middleware's error response be unified with `AllExceptionsFilter`'s envelope** (lowercase `errorCode`, `requestId`, `timestamp`, `data:null`)? As implemented, a client hitting this specific failure mode gets a differently-shaped error body than literally every other error path in the app — worth confirming whether any mobile client code already special-cases this (if so, changing it is a breaking change; if not, this is a straightforward consistency fix).

5. **Are the hard-coded health thresholds (250MB heap, 512MB RSS, 90% disk at `/`) tuned to the actual container/pod resource limits in the deployed environment?** They're not env-configurable. If the container memory limit is, say, 512MB total, the 512MB RSS check would almost never leave headroom to fire before an OOM-kill happens anyway, making that specific check low-value. Confirm against actual infra sizing.

6. **Is `/health`'s disk check on `/` monitoring the volume that actually matters in production** (e.g. if the app runs in a container with an ephemeral overlay root distinct from any real persistent/log volume, `/` filling up may not reflect the condition operators actually care about)? Worth confirming the deployment topology.

7. **Should pagination cursors carry any tamper-resistance (e.g. an HMAC) given they're fully client-suppliable and portable across endpoints** (PAG-007, PAG-019)? The current design relies entirely on every `fetch()` callback re-applying the caller's own authorization/tenant scoping regardless of cursor contents — confirm this invariant holds for every current caller (a single caller that trusted the cursor's `id`/`v` without independently re-scoping by the authenticated caller's own tenant/store would be a real cross-tenant risk), or whether a signed cursor is worth the added complexity as a defense-in-depth measure.

8. **Is there meant to be any content/length guard on `User-Agent` (and similarly free-form headers) flowing into `RequestContext`/audit rows**, analogous to `RequestIdMiddleware`'s explicit `SAFE_REQUEST_ID` allowlist regex? Currently no such guard is visible in this module for User-Agent — confirm whether this is an accepted gap (it's stored as inert data, not interpreted/executed anywhere visible) or worth the same treatment given it flows into logs and a persisted audit table.

9. **Does the currently-implemented block duration (always equal to the counting window `ttl`, since no `blockDuration` is ever explicitly configured) match the intended penalty severity for the stricter auth-endpoint throttles** (5/min and 10/min on OTP send/verify)? A 60-second block for exceeding a 5-req/60s limit is a fairly light penalty for a would-be OTP-spam attacker — confirm whether a longer `blockDuration` (e.g. 5-15 minutes) was intended for these specific security-sensitive routes, separate from the DDoS-backstop-only global throttler.

10. **What is the intended behavior of `ResponseInterceptor` on a `204 No Content` route** (e.g. `logout`, `logout/all`, `revokeSession`)? Confirm whether a JSON envelope body is actually written on the wire alongside a 204 status (a spec deviation some HTTP clients handle inconsistently) or whether Nest/Express suppresses the body for 204s regardless of what the interceptor returns — MID-006 needs to be run against the real running app to settle this, not inferred from the source alone.