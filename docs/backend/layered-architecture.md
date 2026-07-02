# Layered Request/Response Architecture — Canonical Reference

The complete, production-grade architecture for every feature module in the
backend. This document is the single source of truth for how an HTTP request
flows through the system, the rules each layer must obey, and the cross-cutting
patterns (transactions, errors, events, observability) that hold the whole
thing together.

The mobile auth module (`apps/backend/src/auth/mobile/`) is the reference
implementation.

> **Implementation status.** This doc mixes what's built with what's planned.
> Sections marked **✅ Implemented** describe code that exists today; treat them
> as accurate to the source. Everything else (the EventBus in §4.3, cache
> decorator §4.6, OpenTelemetry §4.7, the generic idempotency middleware §4.4)
> is a **target design — 📋 not yet implemented**. Don't go looking for those
> files; they aren't there yet.
>
> Recently built: cursor pagination (§4.5), the per-verb service split (§3.5),
> the device request mapper (§3.3), the Unit of Work (§4.1), and the shared
> `parse()` helper (§3.2).
>
> Already real but described generically below: the error hierarchy + filter
> (§4.2), structured logging (via pino, not the hand-rolled logger in §4.7),
> versioned snapshot caching, and refresh-token idempotency (keyed on the token
> hash, not the `Idempotency-Key` header in §4.4).

---

## Table of Contents

1. [The Flow at a Glance](#1-the-flow-at-a-glance)
2. [Directory Layout](#2-directory-layout)
3. [Layer-by-Layer](#3-layer-by-layer)
   - 3.1 [Types & Interfaces (Domain Models)](#31-types--interfaces-domain-models)
   - 3.2 [Request Schema (Input Validation)](#32-request-schema-input-validation)
   - 3.3 [Request Mapper (Input → Domain)](#33-request-mapper-input--domain)
   - 3.4 [Controller (HTTP Handler)](#34-controller-http-handler)
   - 3.5 [Service (Business Logic)](#35-service-business-logic)
   - 3.6 [Repository (Data Access)](#36-repository-data-access)
   - 3.7 [Response Mapper (Domain → Output)](#37-response-mapper-domain--output)
   - 3.8 [Response DTO (Output Contract)](#38-response-dto-output-contract)
4. [Cross-Cutting Patterns](#4-cross-cutting-patterns)
   - 4.1 [Unit of Work (Transactions)](#41-unit-of-work-transactions)
   - 4.2 [Error Handling](#42-error-handling)
   - 4.3 [Domain Events](#43-domain-events)
   - 4.4 [Idempotency](#44-idempotency)
   - 4.5 [Pagination](#45-pagination)
   - 4.6 [Caching](#46-caching)
   - 4.7 [Observability](#47-observability)
5. [Guards & Interceptors](#5-guards--interceptors)
6. [Module Wiring](#6-module-wiring)
7. [A Complete Trace](#7-a-complete-trace-post-authmobileloginverify)
8. [Testing Strategy](#8-testing-strategy)
9. [Layer Responsibility Cheat-Sheet](#9-layer-responsibility-cheat-sheet)
10. [Rules at a Glance](#10-rules-at-a-glance)

---

## 1. The Flow at a Glance

```
HTTP Request (snake_case JSON)
    │
    ▼
┌────────────────────────────────────────┐
│  REQUEST SCHEMA (Zod)                  │   Validate input, infer typed DTO
└────────────────────────────────────────┘
    │
    ▼
┌────────────────────────────────────────┐
│  CONTROLLER                            │   Parse, delegate, return mapped DTO
└────────────────────────────────────────┘
    │
    ▼  (via Request Mapper: snake_case → camelCase)
┌────────────────────────────────────────┐
│  SERVICE (Use Case)                    │   Business logic, orchestration
└────────────────────────────────────────┘
    │
    ▼  (via Unit of Work when ≥2 writes)
┌────────────────────────────────────────┐
│  REPOSITORY                            │   Drizzle queries, raw entities
└────────────────────────────────────────┘
    │
    ▼
┌────────────────────────────────────────┐
│  DATABASE (Postgres)                   │
└────────────────────────────────────────┘
    │   (entities flow back up as domain results)
    ▼
┌────────────────────────────────────────┐
│  RESPONSE MAPPER (pure)                │   Domain result → Response DTO
└────────────────────────────────────────┘
    │
    ▼
┌────────────────────────────────────────┐
│  RESPONSE DTO (interface)              │   snake_case JSON contract
└────────────────────────────────────────┘
    │
    ▼
HTTP Response (snake_case JSON)
```

### The Golden Rule — Dependencies Point Down and Inward Only

```
Controller       → Request Schema, Request Mapper, Service, Response Mapper
Request Mapper   → Domain types
Response Mapper  → Domain types, Response DTO
Service          → Repository, other Services, Domain Events, UoW
Repository       → Drizzle schema
Response DTO     → (nothing — leaf node)
Request Schema   → (Zod only — leaf node)
```

A lower layer never imports an upper layer. **A mapper never imports a
controller. A response DTO never imports anything from the module. The service
layer never emits snake_case.**

snake_case lives at the edges (HTTP wire format). camelCase lives everywhere
inside. The two mapper boundaries — request mapping in, response mapping out —
are the **only** places the two worlds touch.

---

## 2. Directory Layout

```
auth/mobile/
├── dto/
│   ├── request/                          # Zod schemas (snake_case wire format)
│   │   ├── device.request.ts
│   │   ├── otp.request.ts
│   │   ├── refresh.request.ts
│   │   └── step-up.request.ts
│   └── response/                         # Plain interfaces (snake_case)
│       ├── otp.response.ts
│       ├── auth.response.ts
│       └── session.response.ts
├── mappers/
│   ├── request/                          # snake_case DTO → camelCase domain
│   │   ├── device.request-mapper.ts
│   │   └── otp.request-mapper.ts
│   └── response/                         # camelCase domain → snake_case DTO
│       ├── auth.response-mapper.ts
│       └── session.response-mapper.ts
├── repositories/                         # Data access — raw entities only
│   ├── auth-session.repository.ts
│   ├── device.repository.ts
│   ├── otp-request.repository.ts
│   └── refresh-token.repository.ts
├── services/                             # Business logic, one verb-family each
│   ├── auth-login.service.ts             # loginStageOne, loginStageTwo
│   ├── auth-refresh.service.ts           # rotate, detectReuse
│   ├── auth-logout.service.ts            # logoutSession, logoutAll
│   ├── auth-step-up.service.ts           # requestStepUp, verifyStepUp
│   └── auth-device.service.ts            # upsertDevice, trustDevice
├── events/                               # Domain events emitted by services
│   ├── auth-login.event.ts
│   └── auth-logout.event.ts
├── handlers/                             # Event handlers for side effects
│   ├── log-login-audit.handler.ts
│   ├── send-login-notification.handler.ts
│   └── update-last-login.handler.ts
├── guards/
│   └── mobile-jwt.guard.ts
├── interceptors/
│   └── snapshot-refresh.interceptor.ts
├── types/
│   ├── mobile-principal.ts               # Request-scoped principal (camelCase)
│   ├── login-result.ts                   # Domain result types
│   └── rotate-result.ts
├── mobile-auth.controller.ts
└── mobile-auth.module.ts
```

**Cross-module shared code.** Today it lives in `common/` and `db/`. Lines
marked 📋 are planned (see §4) and not yet present.

```
common/
├── exceptions/
│   └── app.exception.ts                  # ✅ AppException (extends HttpException)
├── filters/
│   └── http-exception.filter.ts          # ✅ AllExceptionsFilter — single HTTP translation point
├── error-codes.ts                        # ✅ ErrorCodes enum
├── middleware/
│   └── request-id.middleware.ts          # ✅ x-request-id generation/propagation
├── validation/
│   └── parse.ts                          # ✅ shared Zod parse() helper
└── pagination/
    ├── cursor.ts                         # ✅ encode/decode opaque cursor
    ├── paginate.ts                       # ✅ generic paginateByCursor() helper
    └── paginated-response.ts             # ✅ PaginatedResponse<T> + clampLimit

db/
└── db.module.ts                          # ✅ DRIZZLE provider, Database/DbExecutor types, UnitOfWork

logger/
└── logger.module.ts                      # ✅ pino structured logging (nestjs-pino)

# 📋 Planned, not yet implemented:
#   events/        — EventBus, domain events            (§4.3)
#   validation/    — Zod validation pipe form            (§3.2; parse() helper already exists)
#   cache/         — cache-aside decorator               (§4.6; snapshot.service already does versioned caching)
#   observability/ — OpenTelemetry @Traced(), metrics    (§4.7; structured logging already exists via pino)
#   http/          — generic Idempotency-Key middleware  (§4.4; refresh already has token-hash idempotency)
```

---

## 3. Layer-by-Layer

### 3.1 Types & Interfaces (Domain Models)

The core objects that actually exist in the system. **camelCase, internal**.
They never cross the wire as-is.

**Three flavors:**

1. **Persistence entities** — inferred straight from Drizzle, returned by
   repositories.
2. **Domain result types** — purpose-built shapes describing the outcome of a
   service operation, input to response mappers.
3. **Request-scoped principals** — attached to `req.user` by guards.

```ts
// types/login-result.ts — domain result, returned by service
export interface LoginResult {
  accessToken: string;
  refreshToken: string;
  user: {
    id: string; // public guuid
    permissionsVersion: number;
  };
  isNewUser: boolean;
  deviceGuuid: string;
  deviceSessionGuuid: string;
  isTrusted: boolean;
}
```

```ts
// types/mobile-principal.ts — request-scoped, attached by guard
export interface MobilePrincipal {
  userId: string;
  userGuuid: string;
  deviceSessionId: string;
  deviceId: string;
  devicePlatform: string;
  permissionsVersion: number;
  stepUpAt?: Date;
  stepUpMethod?: string;
  currentJti?: string;
  currentJtiExp?: Date;
}
```

```ts
// Persistence entity — inferred from Drizzle
import { deviceSessions } from '@db/schema';
export type DeviceSession = typeof deviceSessions.$inferSelect;
```

**Rules:**

- Domain types are camelCase.
- snake_case appears _only_ in `dto/request/` and `dto/response/`.
- A persistence entity never escapes the repository's caller boundary — services
  may handle them, but services **return domain results**, not entities, to
  controllers.

---

### 3.2 Request Schema (Input Validation)

Validates and shapes everything coming from the client, using **Zod**. The
wire format is snake_case (the client contract). Lives in `dto/request/`,
split by concern so shared pieces are declared once.

```ts
// dto/request/device.request.ts
export const PHONE_REGEX = /^\+?[1-9]\d{6,14}$/;

export const DeviceDtoSchema = z.object({
  platform: z.enum(['ios', 'android']),
  app_version: z.string(),
  os_version: z.string().optional(),
  model: z.string().optional(),
  public_key: z.string().optional(),
  push_token: z.string().optional(),
});
export type DeviceDto = z.infer<typeof DeviceDtoSchema>;
```

```ts
// dto/request/otp.request.ts
export const OtpVerifyDtoSchema = z.object({
  phone: z.string().regex(PHONE_REGEX),
  otp_code: z.string().length(6),
  otp_request_id: z.string().uuid(),
  device: DeviceDtoSchema,
});
export type OtpVerifyDto = z.infer<typeof OtpVerifyDtoSchema>;
```

**Cross-field rules use `superRefine`:**

```ts
// dto/request/step-up.request.ts
export const StepUpVerifyDtoSchema = z
  .object({
    method: z.enum(['otp_sms', 'biometric', 'totp', 'password_reentry']),
    credential: z.string().min(1),
    otp_request_id: z.string().uuid().optional(),
    challenge_id: z.string().uuid().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.method === 'otp_sms' && !v.otp_request_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'otp_request_id required for otp_sms',
        path: ['otp_request_id'],
      });
    }
    if (v.method === 'biometric' && !v.challenge_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'challenge_id required for biometric',
        path: ['challenge_id'],
      });
    }
  });
```

**The `parse()` helper** — ✅ shared utility in `common/validation/parse.ts`,
used by every controller:

```ts
// common/validation/parse.ts
import { UnprocessableEntityException } from '@nestjs/common';
import type { ZodType } from 'zod';

export function parse<T>(body: unknown, schema: ZodType<T>): T {
  const result = schema.safeParse(body);
  if (!result.success)
    throw new UnprocessableEntityException(result.error.issues);
  return result.data;
}
```

It throws Nest's `UnprocessableEntityException` (422); the global
`AllExceptionsFilter` renders it as the standard error body.

**Rules:**

- Wire format is snake_case (client contract).
- The inferred `z.infer<>` type is the only request shape the controller
  trusts — no `as` casts that can drift from the schema.
- Validation runs **before** any business logic.

---

### 3.3 Request Mapper (Input → Domain) — ✅ Implemented

Converts the validated snake_case DTO into the camelCase domain shape the
service expects. **Pure functions, no DI, no async.** Symmetric with response
mappers.

`DeviceRequestMapper` lives in `mappers/device.request-mapper.ts`; the
controller calls `DeviceRequestMapper.toDomain(dto.device)` in both
`loginVerify` and `signupVerify` instead of reshaping the device object inline.

```ts
// mappers/device.request-mapper.ts
import type { DeviceDto } from '../dto/request/device.request.js';
import type { DeviceInfo } from '../services/device.service.js';

export const DeviceRequestMapper = {
  toDomain(dto: DeviceDto): DeviceInfo {
    return {
      platform: dto.platform,
      appVersion: dto.app_version,
      osVersion: dto.os_version,
      model: dto.model,
      publicKey: dto.public_key ?? '',
      pushToken: dto.push_token,
    };
  },
};
```

**Rules:**

- Pure functions. No side effects, no async, no I/O.
- The only place snake_case becomes camelCase on the way in.
- One mapper per nested DTO that needs reshaping (top-level requests usually
  destructure inline; nested objects like `device` get their own mapper).

---

### 3.4 Controller (HTTP Handler)

Thin. It only: parses the body via Zod, maps to domain, calls one service,
maps the result, returns. **No business logic, no DB access, no response-shape
construction inline.**

```ts
// mobile-auth.controller.ts
@Controller('auth/mobile')
export class MobileAuthController {
  constructor(
    private readonly loginService: AuthLoginService,
    private readonly refreshService: AuthRefreshService,
    private readonly logoutService: AuthLogoutService,
  ) {}

  @Post('login/verify')
  @HttpCode(200)
  async loginVerify(
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<LoginResponse> {
    const dto = parse(body, OtpVerifyDtoSchema); // Schema
    const device = DeviceRequestMapper.toDomain(dto.device); // Request Mapper

    const result = await this.loginService.loginStageTwo({
      // Service
      phone: dto.phone,
      otpCode: dto.otp_code,
      otpRequestId: dto.otp_request_id,
      device,
      ip: getIp(req),
    });

    return AuthResponseMapper.toLoginResponse(result); // Response Mapper
  }

  @Post('refresh')
  @HttpCode(200)
  async refresh(
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<RefreshResponse> {
    const dto = parse(body, RefreshDtoSchema);
    const result = await this.refreshService.rotate({
      refreshToken: dto.refresh_token,
      ip: getIp(req),
    });
    return AuthResponseMapper.toRefreshResponse(result);
  }
}
```

**Rules:**

- Every handler declares an explicit `Promise<XxxResponse>` return type. The
  compiler then enforces the mapper output matches the published contract — a
  drift becomes a build error, not a production surprise.
- Controllers depend on schemas, request mappers, services, response mappers.
  Nothing else.
- One handler = one schema parse + one service call + one mapper call. If you
  need branching, that's a sign the controller is doing too much — move it
  into the service.

---

### 3.5 Service (Business Logic)

Orchestrates repositories, applies business rules, coordinates side effects
through events, manages transactions through Unit of Work. Returns a **domain
result** — never a snake_case response shape, never an HTTP concern.

#### Service Decomposition Rule

> **A service method represents one use case. A service class groups related
> use cases for a single aggregate. When a service exceeds ~7 methods or
> ~400 lines, split it by use-case family.**

This prevents "god services" — every change risks breaking unrelated logic.

> **✅ Implemented.** The former `MobileAuthService` (6 methods, 3 verb-families,
> 13 injected deps) was split into `AuthLoginService`, `AuthSignupService`, and
> `AuthLogoutService` (logout only needs 4 deps). Shared result types live in
> `types/auth-result.ts`. The controller injects the three focused services.

```ts
// services/auth-login.service.ts
@Injectable()
export class AuthLoginService {
  constructor(
    private readonly otpRepo: OtpRequestRepository,
    private readonly userRepo: UserRepository,
    private readonly sessionRepo: AuthSessionRepository,
    private readonly otpService: OtpService,
    private readonly deviceService: DeviceService,
    private readonly tokenService: RefreshTokenService,
    private readonly crypto: CryptoService,
    private readonly rateLimit: RateLimitService,
    private readonly eventBus: EventBus,
    private readonly uow: UnitOfWork,
  ) {}

  @Traced()
  async loginStageTwo(cmd: LoginStageTwoCommand): Promise<LoginResult> {
    // ── Pre-transaction: read-only checks ─────────────────────────────────
    await this.rateLimit.checkIpLimit(cmd.ip);

    const otpRequest = await this.otpRepo.findActiveRequest(
      cmd.otpRequestId,
      cmd.phone,
    );
    if (!otpRequest) {
      throw new AppException(ErrorCodes.OTP_EXPIRED, 422, 'OTP expired');
    }

    const user = await this.userRepo.findByPhone(cmd.phone);
    if (!user) {
      throw new AppException(ErrorCodes.USER_NOT_FOUND, 401, 'User not found');
    }

    try {
      await this.otpService.verifyOtp(cmd.phone, cmd.otpCode, otpRequest);
    } catch (err) {
      await this.handleFailedOtp(user.id); // lockout enforcement
      throw err;
    }

    // ── Transactional boundary: all writes succeed or none do ─────────────
    const txResult = await this.uow.execute(async (tx) => {
      await this.userRepo.markPhoneVerified(user.id, tx);
      await this.userRepo.resetFailedAttempts(user.id, tx);

      const device = await this.deviceService.upsertDevice(
        user.id,
        { ...cmd.device, lastIp: cmd.ip },
        tx,
      );

      const session = await this.sessionRepo.create(
        {
          userFk: user.id,
          deviceFk: device.id,
          ipAtCreation: cmd.ip,
          expiresAt: addDays(new Date(), 30),
        },
        tx,
      );

      const refreshToken = await this.tokenService.issueRefreshToken(
        session.id,
        tx,
      );

      return { device, session, refreshToken };
    });

    // ── Post-transaction: side effects via events ─────────────────────────
    const accessToken = await this.crypto.signJwt(user.id, txResult.session.id);

    this.eventBus.publish({
      type: 'auth.user.logged_in',
      occurredAt: new Date(),
      aggregateId: user.id,
      payload: {
        userId: user.id,
        deviceId: txResult.device.id,
        sessionId: txResult.session.id,
        ip: cmd.ip,
        isNewDevice: !txResult.device.lastSeenAt,
      },
    });

    return {
      accessToken,
      refreshToken: txResult.refreshToken,
      user: { id: user.guuid, permissionsVersion: user.permissionsVersion },
      isNewUser: false,
      deviceGuuid: txResult.device.id,
      deviceSessionGuuid: txResult.session.id,
      isTrusted: txResult.device.isTrusted,
    };
  }

  private async handleFailedOtp(userId: string): Promise<void> {
    /* … */
  }
}
```

**Rules:**

- Services depend on repositories, other services, EventBus, and UoW — never on
  controllers, mappers, or DTOs.
- They throw typed `AppException`s for error cases; they don't know about HTTP
  status codes beyond the code carried on the exception.
- **Any method that writes to ≥2 repositories MUST use the Unit of Work.**
- Side effects with external systems (push, email, audit) go through events —
  not direct calls — so the service stays focused on the core flow.
- Pre-transaction: read-only validation. Inside transaction: all writes.
  Post-transaction: external side effects via events.

---

### 3.6 Repository (Data Access)

The only layer that talks to the database. Returns **raw entities** (Drizzle
`$inferSelect` rows) — no transformation, no business rules.

**Repositories accept an optional transaction** so services can compose them
into a Unit of Work:

```ts
// repositories/auth-session.repository.ts
import { DRIZZLE, type DbExecutor } from '../../../db/db.module.js';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

@Injectable()
export class AuthSessionRepository {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>,
  ) {}

  // Write methods take an optional executor so the service can run them
  // inside a UnitOfWork transaction (tx) or standalone (this.db).
  async create(
    data: CreateSessionInput,
    tx?: DbExecutor,
  ): Promise<DeviceSession> {
    const [row] = await (tx ?? this.db)
      .insert(deviceSessions)
      .values(data)
      .returning();
    return row!;
  }

  async findById(id: string): Promise<DeviceSession | null> {
    const [row] = await this.db
      .select()
      .from(deviceSessions)
      .where(eq(deviceSessions.id, id));
    return row ?? null;
  }

  async listActiveSessions(userFk: string): Promise<SessionWithDevice[]> {
    const rows = await this.db
      .select()
      .from(deviceSessions)
      .innerJoin(devices, eq(deviceSessions.deviceFk, devices.id))
      .where(
        and(
          eq(deviceSessions.userFk, userFk),
          isNull(deviceSessions.revokedAt),
        ),
      );
    return rows.map((r) => ({ ...r.device_sessions, device: r.devices }));
  }

  async revokeSession(
    id: string,
    reason = 'user_logout',
    tx?: DbExecutor,
  ): Promise<void> {
    await (tx ?? this.db)
      .update(deviceSessions)
      .set({ revokedAt: new Date(), revokedReason: reason })
      .where(eq(deviceSessions.id, id));
  }
}
```

**Composite query results** are returned as typed shapes — never raw join
rows that callers have to deconstruct:

```ts
// types/session-with-device.ts
export interface SessionWithDevice extends DeviceSession {
  device: Device;
}
```

**Rules:**

- Repositories never shape a response.
- Repositories never apply business rules ("if user is locked, throw" → that's
  a service concern).
- Write methods accept an optional `tx?: DbExecutor` so the service can
  compose them into a Unit of Work. Read-only methods don't need it.
- A join result is returned as a typed composite entity; the mapper decides
  what the client sees.
- One repository per aggregate root. Don't share repositories across
  unrelated tables.

---

### 3.7 Response Mapper (Domain → Output)

Pure functions that translate domain results into the public snake_case
contract. **No DI, no side effects, no async.** This is where camelCase
becomes snake_case and where secrets are stripped.

```ts
// mappers/response/auth.response-mapper.ts
import type { LoginResult, RotateResult } from '../../types/index.js';
import type {
  LoginResponse,
  RefreshResponse,
} from '../../dto/response/auth.response.js';

export const AuthResponseMapper = {
  toLoginResponse(r: LoginResult): LoginResponse {
    return {
      access_token: r.accessToken,
      refresh_token: r.refreshToken,
      user: {
        id: r.user.id,
        permissions_version: r.user.permissionsVersion,
      },
      is_new_user: r.isNewUser,
      device_guuid: r.deviceGuuid,
      device_session_guuid: r.deviceSessionGuuid,
      is_trusted: r.isTrusted,
    };
  },

  toRefreshResponse(r: RotateResult): RefreshResponse {
    return {
      access_token: r.accessToken,
      refresh_token: r.refreshToken,
      snapshot_version: r.snapshotVersion,
    };
  },
};
```

**Secret-stripping by construction** — the session mapper exposes only
client-safe fields and deliberately drops `currentJti`, `currentJtiExp`,
`revokedReason`:

```ts
// mappers/response/session.response-mapper.ts
export const SessionResponseMapper = {
  toSessionResponse(
    s: SessionWithDevice,
    currentSessionId: string,
  ): SessionResponse {
    return {
      id: s.id,
      device_name: s.deviceName ?? s.device.model ?? null,
      os: s.os ?? s.device.osVersion ?? null,
      platform: s.platform ?? s.device.platform ?? null,
      app_version: s.appVersion ?? null,
      ip_at_creation: s.ipAtCreation ?? null,
      last_used_at: s.lastUsedAt.toISOString(),
      last_step_up_at: s.lastStepUpAt?.toISOString() ?? null,
      created_at: s.createdAt.toISOString(),
      is_current: s.id === currentSessionId,
      // currentJti / currentJtiExp / revokedReason intentionally NOT exposed
    };
  },

  toSessionListResponse(
    sessions: SessionWithDevice[],
    currentSessionId: string,
  ): SessionResponse[] {
    return sessions.map((s) =>
      SessionResponseMapper.toSessionResponse(s, currentSessionId),
    );
  },
};
```

**Rules:**

- Pure functions. No DI, no side effects, no async, no I/O.
- Mappers import _down_ into `dto/response/` for their return types and
  _sideways_ into types/services for their input types.
- **Nothing imports a mapper except the controller (and tests).**
- List fields explicitly — never spread an entity (`...session`). A new
  sensitive column should be invisible to clients by default until someone
  deliberately maps it. **Security by omission, not by blocklist.**
- Trivially unit-testable: no mocks, no HTTP, no DB.

---

### 3.8 Response DTO (Output Contract)

Plain TypeScript interfaces describing exactly what the API returns.
snake_case. **Compile-time only — zero runtime cost.** This is the published
contract; the mobile client mirrors these shapes.

```ts
// dto/response/auth.response.ts
export interface LoginResponse {
  access_token: string;
  refresh_token: string;
  user: AuthUserResponse;
  is_new_user: boolean;
  device_guuid: string;
  device_session_guuid: string;
  is_trusted: boolean;
}

export interface AuthUserResponse {
  id: string;
  permissions_version: number;
}

export interface RefreshResponse {
  access_token: string;
  refresh_token: string;
  snapshot_version: number;
}
```

**Rules:**

- Response DTOs are leaf nodes in the dependency graph — they import nothing
  from the module.
- Changing one is a deliberate contract change, visible in a single file.
- Interfaces, not classes (no runtime cost, no constructors).
- snake_case throughout (client contract).

---

## 4. Cross-Cutting Patterns

### 4.1 Unit of Work (Transactions) — ✅ Implemented

**Rule:** Any service method that writes to ≥2 repositories MUST use a
transaction. The Unit of Work pattern provides this without coupling
services to Drizzle internals.

The UoW and its supporting types live in `db/db.module.ts` (next to the
`DRIZZLE` provider) and are exported from the `@Global() DbModule`, so any
module can inject `UnitOfWork` with no extra wiring.

```ts
// db/db.module.ts
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';

/** The application's Drizzle database handle (postgres-js driver). */
export type Database = PostgresJsDatabase<typeof schema>;

/** A transaction handle, as passed to the callback of `db.transaction(...)`. */
export type DbTransaction = Parameters<
  Parameters<Database['transaction']>[0]
>[0];

/**
 * Anything a repository can run queries against — the root handle or a live
 * transaction. Repositories accept `tx?: DbExecutor` and fall back to their
 * injected `db`, so the same method works inside or outside a transaction.
 */
export type DbExecutor = Database | DbTransaction;

@Injectable()
export class UnitOfWork {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  execute<T>(work: (tx: DbTransaction) => Promise<T>): Promise<T> {
    return this.db.transaction((tx) => work(tx));
  }
}
```

**Repositories accept an optional `tx?: DbExecutor`** and run on `tx ?? this.db`:

```ts
// repositories/auth-session.repository.ts
async create(data: CreateSessionInput, tx?: DbExecutor): Promise<DeviceSession> {
  const [row] = await (tx ?? this.db).insert(deviceSessions).values(data).returning();
  return row!;
}
```

Service-level collaborators that wrap a repo write thread it through too —
`DeviceService.upsertDevice(userId, info, tx?)`,
`RefreshTokenService.issueRefreshToken(sessionId, tx?)`, and the private
`handleSuccessfulLogin(userId, tx?)` in `MobileAuthService`.

**Rules for what goes inside the transaction:**

| Operation                   | Inside tx? | Reasoning                                      |
| --------------------------- | :--------: | ---------------------------------------------- |
| DB writes to same aggregate |     ✅     | Must be atomic                                 |
| DB writes across aggregates |     ✅     | Must be atomic                                 |
| DB reads (validation)       |   Before   | No need to hold a write lock                   |
| JWT signing                 |  ❌ After  | CPU work; don't hold a lock across it          |
| External API calls          |  ❌ After  | Don't hold locks during slow calls             |
| Sending push / email        |  ❌ After  | Side effect; failure shouldn't roll back login |
| Audit log                   |  ❌ After  | Failure shouldn't roll back a successful login |
| Rate-limit recording        |  ❌ After  | Side effect; eventual consistency is fine      |
| Cache invalidation          |  ❌ After  | Consistency is eventual                        |

**The real `loginStageTwo` pattern** (from `mobile-auth.service.ts`):

```ts
async loginStageTwo(phone, otpCode, otpRequestId, deviceInfo, ip): Promise<LoginResult> {
  // 1. Pre-transaction: read-only validation
  await this.rateLimit.checkIpLimit(ip);
  const otpRequest = await this.otpRepo.findActiveRequest(otpRequestId, phone);
  if (!otpRequest) throw new AppException(ErrorCodes.TOKEN_EXPIRED, 'OTP_EXPIRED', 422);
  const [user] = await this.db.select().from(users).where(eq(users.phone, phone));
  if (!user) throw new AppException(ErrorCodes.NOT_FOUND, 'USER_NOT_FOUND', 401);

  try {
    await this.otpService.verifyOtp(phone, otpCode, otpRequest);
  } catch (err) {
    await this.handleFailedOtp(user.id);   // lockout enforcement (§18.4)
    throw err;
  }

  // 2. Transactional boundary: all writes commit together or roll back together
  const { device, session, refreshToken } = await this.uow.execute(async (tx) => {
    await this.handleSuccessfulLogin(user.id, tx);
    const device  = await this.deviceService.upsertDevice(user.id, { ...deviceInfo, lastIp: ip }, tx);
    const session = await this.sessionRepo.create({ /* … */ }, tx);
    const refreshToken = await this.tokenService.issueRefreshToken(session.id, tx);
    return { device, session, refreshToken };
  });

  // 3. Post-transaction: token signing + external side effects
  const accessToken = await this.crypto.signJwt(user.id, session.id);
  await this.audit.log({ /* … */ });
  await this.rateLimit.recordAttempt({ ip, phone, purpose: 'login', success: true });

  return { accessToken, refreshToken, /* … */ };
}
```

> **Bug this closes:** previously a failure in `issueRefreshToken` _after_
> `sessionRepo.create` succeeded left an orphan device/session with no usable
> token. Now it's all-or-nothing. `signupStageTwo` follows the same shape, with
> the `users` insert also inside the transaction.

> **Note on events:** the post-transaction side effects above are still direct
> calls (`audit.log`, `recordAttempt`), not domain events — the EventBus in §4.3
> is not yet implemented. When it lands, these move into event handlers.

---

### 4.2 Error Handling — ✅ Implemented (shape differs)

> **Reality check.** Error handling exists today: `common/exceptions/app.exception.ts`
> (`AppException`), `common/error-codes.ts` (`ErrorCodes`), and a global
> `AllExceptionsFilter` in `common/filters/http-exception.filter.ts` (handles
> `ThrottlerException`, `AppException`, `HttpException`, and postgres errors).
> The actual `AppException` **extends `HttpException`** with the signature
> `(errorCode, message, statusCode)` — the richer subclass hierarchy and
> `Error`-based shape below is a _target_, not the current code.

**Target — codified exception hierarchy** (planned refinement):

```ts
// shared/errors/app-exception.ts
export class AppException extends Error {
  constructor(
    public readonly code: ErrorCode, // 'OTP_EXPIRED'
    public readonly httpStatus: number, // 422
    public readonly publicMessage: string, // safe to show user
    public readonly metadata?: Record<string, unknown>,
  ) {
    super(publicMessage);
    this.name = this.constructor.name;
  }
}

// Specific subclasses for common cases:
export class ValidationException extends AppException {
  constructor(
    code: ErrorCode,
    status = 422,
    msg = 'Invalid request',
    meta?: any,
  ) {
    super(code, status, msg, meta);
  }
}

export class NotFoundException extends AppException {
  constructor(code: ErrorCode, msg = 'Resource not found') {
    super(code, 404, msg);
  }
}

export class UnauthorizedException extends AppException {
  constructor(code: ErrorCode, msg = 'Authentication required') {
    super(code, 401, msg);
  }
}

export class ForbiddenException extends AppException {
  constructor(code: ErrorCode, msg = 'Forbidden') {
    super(code, 403, msg);
  }
}

export class RateLimitException extends AppException {
  constructor(public readonly retryAfter: number) {
    super('RATE_LIMITED', 429, 'Too many requests', { retryAfter });
  }
}
```

**Error codes are an enum** (single source of truth, kept in sync with mobile):

```ts
// shared/errors/error-codes.ts
export const ErrorCodes = {
  // Auth
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  TOKEN_INVALID: 'TOKEN_INVALID',
  TOKEN_REUSED: 'TOKEN_REUSED',
  OTP_EXPIRED: 'OTP_EXPIRED',
  OTP_INVALID: 'OTP_INVALID',
  USER_NOT_FOUND: 'USER_NOT_FOUND',
  USER_LOCKED: 'USER_LOCKED',
  USER_BLOCKED: 'USER_BLOCKED',
  PHONE_NOT_VERIFIED: 'PHONE_NOT_VERIFIED',
  STEP_UP_REQUIRED: 'STEP_UP_REQUIRED',

  // Validation
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  RATE_LIMITED: 'RATE_LIMITED',

  // System
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];
```

**A single filter translates exceptions to HTTP** — the ONE place HTTP cares
about exceptions:

```ts
// shared/errors/app-exception.filter.ts
@Catch()
export class AppExceptionFilter implements ExceptionFilter {
  constructor(private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const traceId = request.id;

    if (exception instanceof AppException) {
      return response.status(exception.httpStatus).json({
        error: {
          code: exception.code,
          message: exception.publicMessage,
          trace_id: traceId,
          ...(exception.metadata && { metadata: exception.metadata }),
        },
      });
    }

    if (exception instanceof ZodError) {
      return response.status(422).json({
        error: {
          code: ErrorCodes.VALIDATION_FAILED,
          message: 'Invalid request',
          trace_id: traceId,
          issues: exception.issues,
        },
      });
    }

    // Unknown — log full stack, return generic
    this.logger.error('Unhandled exception', { exception, traceId });
    return response.status(500).json({
      error: {
        code: ErrorCodes.INTERNAL_ERROR,
        message: 'An unexpected error occurred',
        trace_id: traceId,
      },
    });
  }
}
```

**Rules:**

- Services throw `AppException` (or a subclass). Never throw raw `Error`.
- Every exception carries an `ErrorCode` from the enum.
- The filter is the ONLY place that knows about HTTP status codes.
- The `publicMessage` is safe to show users. Internal details go in `metadata`.

---

### 4.3 Domain Events

Decoupled side effects through an in-process event bus. Services emit events;
handlers subscribe independently. New side effects don't touch the service.

```ts
// shared/events/domain-event.ts
export interface DomainEvent<T = unknown> {
  type: string;
  occurredAt: Date;
  aggregateId: string;
  payload: T;
}

// shared/events/event-bus.ts
@Injectable()
export class EventBus {
  private readonly handlers = new Map<string, EventHandler[]>();

  publish<T>(event: DomainEvent<T>): void {
    const handlers = this.handlers.get(event.type) ?? [];
    // Fire-and-forget; handlers run async
    handlers.forEach((h) =>
      h
        .handle(event)
        .catch((err) =>
          this.logger.error('Event handler failed', { event, err }),
        ),
    );
  }

  register(type: string, handler: EventHandler): void {
    const existing = this.handlers.get(type) ?? [];
    this.handlers.set(type, [...existing, handler]);
  }
}
```

**Event definitions per module:**

```ts
// events/auth-login.event.ts
export interface UserLoggedInPayload {
  userId: string;
  deviceId: string;
  sessionId: string;
  ip: string;
  isNewDevice: boolean;
}

export type UserLoggedInEvent = DomainEvent<UserLoggedInPayload> & {
  type: 'auth.user.logged_in';
};
```

**Handlers subscribe to events, do one thing:**

```ts
// handlers/log-login-audit.handler.ts
@EventHandler('auth.user.logged_in')
export class LogLoginAuditHandler implements DomainEventHandler<UserLoggedInPayload> {
  constructor(private readonly auditService: AuditService) {}

  async handle(event: UserLoggedInEvent): Promise<void> {
    await this.auditService.log({
      event: 'AUTH_LOGIN',
      userId: event.payload.userId,
      ipAddress: event.payload.ip,
    });
  }
}

// handlers/send-new-device-notification.handler.ts
@EventHandler('auth.user.logged_in')
export class SendNewDeviceNotificationHandler implements DomainEventHandler<UserLoggedInPayload> {
  constructor(private readonly pushService: PushService) {}

  async handle(event: UserLoggedInEvent): Promise<void> {
    if (!event.payload.isNewDevice) return;
    await this.pushService.send(event.payload.userId, {
      title: 'New device login',
      body: 'A new device just signed into your account.',
    });
  }
}
```

**When to use events vs direct calls:**

| Pattern                                   | Use Events           | Use Direct Call                |
| ----------------------------------------- | -------------------- | ------------------------------ |
| Audit logging                             | ✅ Always            | —                              |
| Push notifications                        | ✅ Always            | —                              |
| Email sending                             | ✅ Always            | —                              |
| Cache invalidation                        | ✅ Usually           | If you need confirmation       |
| Same-aggregate write                      | —                    | ✅ Direct, in same transaction |
| Cross-aggregate write that MUST be atomic | — (use Saga pattern) | ✅ Direct, in same transaction |

**Rule:** if failure of the side effect should NOT roll back the main flow,
use an event. If it MUST roll back, use a direct call inside the transaction.

---

### 4.4 Idempotency

Two separate idempotency mechanisms are in use — **do not confuse them**:

**Mechanism 1 (✅ Implemented): Token-hash dedup for `/auth/mobile/refresh`**

`RefreshIdempotencyService` uses the SHA256 hash of the refresh token as its natural idempotency key (keyed on `refresh_idem:{tokenHash}`, 60s TTL). This is the real implementation. It is NOT based on an `Idempotency-Key` header.

```
RefreshIdempotencyService:
  ├─ Redis GET "refresh_idem:{SHA256(refreshToken)}"
  │    ├─ HIT (done)    → return cached response immediately
  │    ├─ HIT (pending) → poll for up to 3s
  │    └─ MISS          → SET NX (claim slot, 60s TTL, status=pending)
  └─ after rotation: SET key → {status:done, response}, 60s TTL
```

**Mechanism 2 (📋 Planned): Generic `Idempotency-Key` header middleware**

A planned generic middleware will cover other mutation endpoints. Once built, it will use the `Idempotency-Key` header (client-supplied UUID) cached in Redis for 24h. Mutation endpoints should accept an optional `Idempotency-Key` header. The mobile client should always send one.

```ts
// shared/http/idempotency.middleware.ts  ← 📋 not yet implemented
@Injectable()
export class IdempotencyMiddleware implements NestMiddleware {
  constructor(@Inject(REDIS) private readonly redis: RedisService) {}

  async use(req: Request, res: Response, next: NextFunction): Promise<void> {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();

    const key = req.header('idempotency-key');
    if (!key) return next();

    const cacheKey = `idem:${key}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      const { status, body } = JSON.parse(cached);
      res.status(status).json(body);
      return;
    }

    // Capture response for caching
    const originalJson = res.json.bind(res);
    res.json = (body: unknown) => {
      this.redis
        .setex(
          cacheKey,
          86400,
          JSON.stringify({ status: res.statusCode, body }),
        )
        .catch(() => {
          /* don't fail the response */
        });
      return originalJson(body);
    };

    next();
  }
}
```

**Rule:** all non-GET endpoints accept an optional `Idempotency-Key` header.
The mobile client always sends one. The server caches the response for 24h.

---

### 4.5 Pagination — ✅ Implemented (cursor)

**Two styles, cursor is the default.** This is a mobile-first app, so most list
endpoints are feeds → cursor. Offset exists for the exception: page-numbered admin
tables that need `totalPages` / random page access.

| The endpoint is…                          | Use        | Why                                          |
| ----------------------------------------- | ---------- | -------------------------------------------- |
| Mobile list / infinite scroll / feed      | **Cursor** | append UX, stable under concurrent writes    |
| Anything hot, or that can page deep       | **Cursor** | O(log n) via index; offset is O(offset)      |
| Admin table needing page numbers + totals | **Offset** | only offset yields `totalPages` / page jumps |

> Cursor is stable under concurrent inserts/deletes (offset silently skips or
> repeats rows when the set shifts between page loads) and stays O(log n) at depth.
> The trade-off — no `totalElements`/`totalPages` — is exactly fine for "load more".
> The offset variant + its safe-sort whitelist live in
> `design-adoption-from-ayphen3.md §2.8.1`; the cursor variant in §2.8.2.

Implemented under `common/pagination/`:

```ts
// common/pagination/cursor.ts
export interface Cursor {
  id: string;
  v: string;
} // v = ISO sort value
export function encodeCursor(id: string, v: string): string; // base64url({id, v})
export function decodeCursor(cursor: string): Cursor; // throws 400 INVALID_CURSOR

// common/pagination/paginated-response.ts
export interface PaginatedResponse<T> {
  data: T[];
  next_cursor: string | null;
  has_more: boolean;
}
export function clampLimit(raw: unknown, { def = 20, max = 100 } = {}): number;
```

**A generic `paginateByCursor()` helper** owns the keyset predicate + `limit + 1`
look-ahead + next-cursor construction, so repositories stay thin:

```ts
// common/pagination/paginate.ts (shape)
paginateByCursor<T>({
  cursor, limit,
  sortColumn,          // DESC-ordered column (e.g. deviceSessions.createdAt)
  tieColumn,           // unique tie-breaker (e.g. deviceSessions.id)
  fetch,               // (keyset, take) => rows; applies ORDER BY … DESC + limit(take)
  sortValue, idValue,  // extract cursor fields from the last row
}): Promise<{ items: T[]; nextCursor: string | null; hasMore: boolean }>;
```

**Repository — real usage:**

```ts
// auth-session.repository.ts
async listActiveSessions(userFk: string, page: { limit: number; cursor?: string }) {
  const base = and(eq(deviceSessions.userFk, userFk), isNull(deviceSessions.revokedAt));
  return paginateByCursor<SessionWithDevice>({
    cursor: page.cursor, limit: page.limit,
    sortColumn: deviceSessions.createdAt,   // fixed/whitelisted — never a raw ?sortBy
    tieColumn:  deviceSessions.id,
    sortValue: (s) => s.createdAt.toISOString(),
    idValue:   (s) => s.id,
    fetch: (keyset, take) => this.db.select().from(deviceSessions)
      .innerJoin(devices, eq(deviceSessions.deviceFk, devices.id))
      .where(keyset ? and(base, keyset) : base)
      .orderBy(desc(deviceSessions.createdAt), desc(deviceSessions.id))
      .limit(take)
      .then((rows) => rows.map((r) => ({ ...r.device_sessions, device: r.devices }))),
  });
}
```

**Controller** reads `?limit`/`?cursor`, clamps, maps to the envelope:

```ts
@Get('sessions')
async listSessions(
  @Req() req: Request,
  @Query('limit') limit?: string,
  @Query('cursor') cursor?: string,
): Promise<PaginatedResponse<SessionResponse>> {
  const p = principalOf(req);
  const page = await this.sessionRepo.listActiveSessions(p.userId, {
    limit: clampLimit(limit), cursor,
  });
  return SessionMapper.toSessionListResponse(page, p.deviceSessionId);   // { data, next_cursor, has_more }
}
```

> **Related cleanup done alongside this:** the `DELETE /sessions/:id` ownership check
> now uses a targeted `findActiveByIdForUser(id, userFk)` (one indexed query, 404 on
> miss) instead of loading every session and `.find()`-ing.

---

### 4.6 Caching

Cache lives in a dedicated layer — **not in repositories** (couples persistence
to cache) **and not in business logic services** (clutters the use case).

**Pattern 1: Cache-aside decorator** for simple reads:

```ts
// shared/cache/cached.decorator.ts
export function Cached(opts: { ttl: number; keyPrefix: string }) {
  return function (target: any, key: string, descriptor: PropertyDescriptor) {
    const original = descriptor.value;

    descriptor.value = async function (...args: any[]) {
      const cache: RedisService = this.cache;
      const cacheKey = `${opts.keyPrefix}:${JSON.stringify(args)}`;

      const hit = await cache.get(cacheKey);
      if (hit) return JSON.parse(hit);

      const result = await original.apply(this, args);
      await cache.setex(cacheKey, opts.ttl, JSON.stringify(result));
      return result;
    };
  };
}
```

**Pattern 2: Versioned cache key** for permission snapshots — increment the
version on write, and stale reads naturally miss the cache:

```ts
@Injectable()
export class PermissionSnapshotService {
  constructor(
    private readonly snapshotRepo: SnapshotRepository,
    @Inject(REDIS) private readonly cache: RedisService,
  ) {}

  async getSnapshot(userId: string, version: number): Promise<Snapshot> {
    const key = `snapshot:${userId}:v${version}`;
    const hit = await this.cache.get(key);
    if (hit) return JSON.parse(hit);

    const snapshot = await this.snapshotRepo.findByUserAndVersion(
      userId,
      version,
    );
    await this.cache.setex(key, 3600, JSON.stringify(snapshot));
    return snapshot;
  }

  // Invalidation = increment version in users table; old keys naturally expire
}
```

**Rules:**

- Never cache in the repository.
- Never cache writes — cache invalidation is the hard part, version-keys avoid it.
- TTL is a backstop, not a strategy: design for keys that naturally expire
  through versioning.

---

### 4.7 Observability

Three primitives, every module uses them:

**1. Distributed tracing via OpenTelemetry:**

```ts
// shared/observability/traced.decorator.ts
import { trace, SpanStatusCode } from '@opentelemetry/api';

const tracer = trace.getTracer('backend');

export function Traced(name?: string) {
  return function (target: any, key: string, descriptor: PropertyDescriptor) {
    const original = descriptor.value;
    const spanName = name ?? `${target.constructor.name}.${key}`;

    descriptor.value = async function (...args: any[]) {
      return await tracer.startActiveSpan(spanName, async (span) => {
        try {
          const result = await original.apply(this, args);
          span.setStatus({ code: SpanStatusCode.OK });
          return result;
        } catch (err) {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: (err as Error).message,
          });
          span.recordException(err as Error);
          throw err;
        } finally {
          span.end();
        }
      });
    };
  };
}
```

**2. Structured logger with auto-injected trace context:**

```ts
// shared/observability/logger.ts
@Injectable()
export class Logger {
  info(message: string, metadata?: Record<string, unknown>): void {
    this.write('info', message, metadata);
  }

  warn(message: string, metadata?: Record<string, unknown>): void {
    this.write('warn', message, metadata);
  }

  error(message: string, metadata?: Record<string, unknown>): void {
    this.write('error', message, metadata);
  }

  private write(
    level: string,
    message: string,
    metadata?: Record<string, unknown>,
  ): void {
    const span = trace.getActiveSpan();
    const traceId = span?.spanContext().traceId;
    const spanId = span?.spanContext().spanId;

    process.stdout.write(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level,
        message,
        trace_id: traceId,
        span_id: spanId,
        ...metadata,
      }) + '\n',
    );
  }
}
```

**3. Metrics — the four golden signals:**

```ts
// shared/observability/metrics.ts
import { Counter, Histogram } from 'prom-client';

export const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request latency',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});

export const httpRequestTotal = new Counter({
  name: 'http_requests_total',
  help: 'HTTP request count',
  labelNames: ['method', 'route', 'status'],
});

export const dbQueryDuration = new Histogram({
  name: 'db_query_duration_seconds',
  help: 'Database query latency',
  labelNames: ['operation', 'table'],
});

export const businessEventCounter = new Counter({
  name: 'business_event_total',
  help: 'Business event count',
  labelNames: ['event_type'],
});
```

**Rules:**

- Every public service method has `@Traced()`.
- Every log goes through the `Logger` — never raw `console.log`.
- Every domain event increments a counter (cheap to graph).
- Trace ID propagates from HTTP → service → DB query.

---

## 5. Guards & Interceptors

These run _around_ the controller, not inside the linear flow, but they respect
the same boundaries.

### Guard — Authentication & Authorization

```ts
// guards/mobile-jwt.guard.ts
@Injectable()
export class MobileJwtGuard implements CanActivate {
  constructor(
    private readonly crypto: CryptoService,
    private readonly blacklist: TokenBlacklistService,
    private readonly replay: ReplayProtectionService,
    private readonly sessionRepo: AuthSessionRepository,
    private readonly userRepo: UserRepository,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();

    // 1. Extract Bearer token
    const token = extractBearerToken(request);
    if (!token) {
      throw new UnauthorizedException(ErrorCodes.TOKEN_INVALID);
    }

    // 2. Verify JWT (signature, expiry, type === 'access')
    const payload = await this.crypto.verifyJwt(token);
    if (payload.type !== 'access') {
      throw new UnauthorizedException(ErrorCodes.TOKEN_INVALID);
    }

    // 3. Blacklist check (revoked tokens)
    if (await this.blacklist.isBlacklisted(payload.jti)) {
      throw new UnauthorizedException(ErrorCodes.TOKEN_INVALID);
    }

    // 4. Replay protection
    await this.replay.check(payload.jti);

    // 5. Load session + device + user
    const session = await this.sessionRepo.findById(payload.deviceSessionId);
    if (!session) throw new UnauthorizedException(ErrorCodes.TOKEN_INVALID);
    if (session.revokedAt)
      throw new UnauthorizedException(ErrorCodes.TOKEN_INVALID);
    if (session.expiresAt < new Date())
      throw new UnauthorizedException(ErrorCodes.TOKEN_EXPIRED);

    const user = await this.userRepo.findById(session.userFk);
    if (!user) throw new UnauthorizedException(ErrorCodes.USER_NOT_FOUND);

    // 6. Full account-status block
    if (user.deletedAt)
      throw new UnauthorizedException(ErrorCodes.USER_NOT_FOUND);
    if (user.isBlocked) throw new ForbiddenException(ErrorCodes.USER_BLOCKED);
    if (user.status === 'suspended')
      throw new ForbiddenException(ErrorCodes.USER_BLOCKED);
    if (user.status === 'locked')
      throw new ForbiddenException(ErrorCodes.USER_LOCKED);
    if (user.accountLockedUntil && user.accountLockedUntil > new Date()) {
      throw new ForbiddenException(ErrorCodes.USER_LOCKED);
    }
    if (!user.phoneVerified)
      throw new ForbiddenException(ErrorCodes.PHONE_NOT_VERIFIED);

    // 7. Attach typed principal to request
    const principal: MobilePrincipal = {
      userId: user.id,
      userGuuid: user.guuid,
      deviceSessionId: session.id,
      deviceId: session.deviceFk,
      devicePlatform: session.platform ?? '',
      permissionsVersion: user.permissionsVersion,
      stepUpAt: session.lastStepUpAt ?? undefined,
      stepUpMethod: session.lastStepUpMethod ?? undefined,
      currentJti: session.currentJti ?? undefined,
      currentJtiExp: session.currentJtiExp ?? undefined,
    };
    (request as any).user = principal;

    // 8. Update lastUsedAt (fire-and-forget)
    this.sessionRepo.touchLastUsed(session.id).catch(() => {});

    return true;
  }
}
```

The controller reads `req.user` as `MobilePrincipal` — fully typed, never
guessed.

### Interceptor — Snapshot Refresh

```ts
// interceptors/snapshot-refresh.interceptor.ts
@Injectable()
export class SnapshotRefreshInterceptor implements NestInterceptor {
  constructor(
    private readonly snapshotService: PermissionSnapshotService,
    private readonly ctxService: RequestContextService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return this.ctxService.run(this.buildContext(context), () =>
      next
        .handle()
        .pipe(map((body) => this.maybeAttachSnapshot(body, context))),
    );
  }

  private async maybeAttachSnapshot(body: unknown, context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();
    const principal = (request as any).user as MobilePrincipal | undefined;
    if (!principal) return body;

    // Single emitter rule: this interceptor owns ONLY X-Permissions-Version.
    // X-Subscription-Version is emitted by SubscriptionStatusGuard, not here.
    // Keeping them separate means a subscription change doesn't trigger a
    // snapshot rebuild and vice versa.
    response.setHeader('X-Permissions-Version', principal.permissionsVersion);

    // No-op on error responses — don't append snapshot headers to 4xx/5xx
    const httpResponse = context.switchToHttp().getResponse<Response>();
    if (httpResponse.statusCode >= 400) return body;

    const clientVersion = parseInt(
      request.header('x-permissions-version') ?? '0',
      10,
    );
    if (clientVersion >= principal.permissionsVersion) return body;

    const snapshot = await this.snapshotService.getSnapshot(
      principal.userId,
      principal.permissionsVersion,
    );

    // Don't spread into arrays (e.g., sessions list)
    if (Array.isArray(body)) return { data: body, snapshot };
    if (body && typeof body === 'object') return { ...body, snapshot };
    return body;
  }
}
```

---

## 6. Module Wiring

```ts
// mobile-auth.module.ts
@Module({
  imports: [SharedModule /* … */],
  controllers: [MobileAuthController],
  providers: [
    // Services
    AuthLoginService,
    AuthRefreshService,
    AuthLogoutService,
    AuthStepUpService,
    AuthDeviceService,

    // Repositories
    AuthSessionRepository,
    DeviceRepository,
    OtpRequestRepository,
    RefreshTokenRepository,

    // Event Handlers (auto-register with EventBus)
    LogLoginAuditHandler,
    SendNewDeviceNotificationHandler,
    UpdateLastLoginHandler,

    // Guards & Interceptors
    MobileJwtGuard,
    SnapshotRefreshInterceptor,
  ],
})
export class MobileAuthModule {}
```

**Notes:**

- Mappers are NOT in the providers list — they're plain objects, not injectable.
- Event handlers are registered as providers; the EventBus auto-discovers them
  through their `@EventHandler('...')` decorator at app startup.

---

## 7. A Complete Trace: `POST /auth/mobile/login/verify`

```
1. Client sends snake_case JSON
   { phone, otp_code, otp_request_id, device: { … } }
        │
        ▼
2. Middleware
   ├─ RequestId           → req.id = uuid
   ├─ Idempotency         → check Idempotency-Key in Redis (return cached if hit)
   └─ Tracing             → start root span for HTTP request
        │
        ▼
3. Controller.loginVerify
   ├─ parse(body, OtpVerifyDtoSchema)              [REQUEST SCHEMA]
   │     └─ invalid → AppExceptionFilter → 422 with Zod issues
   └─ DeviceRequestMapper.toDomain(dto.device)     [REQUEST MAPPER]
        │  (snake_case → camelCase)
        ▼
4. AuthLoginService.loginStageTwo(cmd)             [SERVICE]
   ├─ Pre-transaction (read-only):
   │   ├─ RateLimitService.checkIpLimit
   │   ├─ OtpRequestRepository.findActiveRequest   [REPOSITORY/DB]
   │   ├─ UserRepository.findByPhone                [REPOSITORY/DB]
   │   └─ OtpService.verifyOtp
   │       └─ on failure: handleFailedOtp (lockout enforcement)
   │
   ├─ Transactional boundary (UnitOfWork.execute):
   │   ├─ UserRepository.markPhoneVerified(tx)     [REPOSITORY/DB]
   │   ├─ UserRepository.resetFailedAttempts(tx)   [REPOSITORY/DB]
   │   ├─ DeviceService.upsertDevice(tx)            [REPOSITORY/DB]
   │   ├─ AuthSessionRepository.create(tx)         [REPOSITORY/DB]
   │   └─ RefreshTokenService.issueRefreshToken(tx) [REPOSITORY/DB]
   │
   └─ Post-transaction:
       ├─ CryptoService.signJwt
       └─ EventBus.publish('auth.user.logged_in')
           ├─ LogLoginAuditHandler         → AuditService.log (fire-and-forget)
           ├─ UpdateLastLoginHandler       → UserRepository.updateLastLoginAt
           └─ SendNewDeviceNotification    → push if isNewDevice
        │
        │  (returns LoginResult — camelCase domain result)
        ▼
5. AuthResponseMapper.toLoginResponse(result)      [RESPONSE MAPPER]
        │  (camelCase → snake_case, contract-typed by return annotation)
        ▼
6. Interceptor: SnapshotRefresh
   ├─ Sets X-Permissions-Version header
   └─ If client snapshot is stale, attaches signed snapshot to body
        │
        ▼
7. HTTP 200
   {
     "access_token":         "…",
     "refresh_token":        "…",
     "user":                 { "id": "…", "permissions_version": 3 },
     "is_new_user":          false,
     "device_guuid":         "…",
     "device_session_guuid": "…",
     "is_trusted":           true,
     "snapshot":             { … }   // only if stale
   }
```

**The symmetry:** snake_case at the edges (request body, response body),
camelCase everywhere in between (DTO-inferred types, domain commands, results,
entities). The two mapper boundaries — request mapping in, response mapping
out — are the only places the two worlds touch.

---

## 8. Testing Strategy

```
                  ┌──────────────────────┐
                  │  E2E (few)           │   Full HTTP stack, real DB+Redis
                  │  Critical paths      │   ~5 per module
                  └──────────────────────┘
              ┌──────────────────────────────┐
              │  Integration (some)          │   Services + repos, test DB
              │  Use-case flows              │   ~15 per service
              └──────────────────────────────┘
        ┌────────────────────────────────────────┐
        │  Unit (many)                           │   Pure mappers, schemas, helpers
        │  Mappers, schemas, validators          │   ~50 per module
        └────────────────────────────────────────┘
```

**Each layer is testable in isolation:**

```ts
// Mapper test — trivial, no mocks
describe('AuthResponseMapper', () => {
  it('maps LoginResult to snake_case LoginResponse', () => {
    const input: LoginResult = {
      accessToken: 'a', refreshToken: 'r',
      user: { id: 'u1', permissionsVersion: 3 },
      isNewUser: false,
      deviceGuuid: 'd1', deviceSessionGuuid: 's1',
      isTrusted: true,
    };
    expect(AuthResponseMapper.toLoginResponse(input)).toEqual({
      access_token: 'a',
      refresh_token: 'r',
      user: { id: 'u1', permissions_version: 3 },
      is_new_user: false,
      device_guuid: 'd1',
      device_session_guuid: 's1',
      is_trusted: true,
    });
  });
});

// Schema test — pure validation
describe('OtpVerifyDtoSchema', () => {
  it('rejects 5-digit OTP', () => {
    const r = OtpVerifyDtoSchema.safeParse({
      phone: '+919876543210',
      otp_code: '12345',  // too short
      otp_request_id: '550e8400-e29b-41d4-a716-446655440000',
      device: { platform: 'ios', app_version: '1.0.0' },
    });
    expect(r.success).toBe(false);
  });
});

// Service integration test — real DB, mocked external systems
describe('AuthLoginService.loginStageTwo', () => {
  it('issues tokens and creates session on valid OTP', async () => {
    await seedOtpRequest({ phone, otpCode: '123456' });
    await seedUser({ phone });

    const result = await service.loginStageTwo({
      phone, otpCode: '123456', otpRequestId, device, ip: '1.2.3.4',
    });

    expect(result.accessToken).toBeDefined();
    const session = await db.query.deviceSessions.findFirst({
      where: eq(deviceSessions.id, result.deviceSessionGuuid),
    });
    expect(session).toBeDefined();
  });

  it('rolls back all writes if any step fails', async () => {
    mockTokenService.issueRefreshToken.mockRejectedValue(new Error('boom'));

    await expect(service.loginStageTwo(cmd)).rejects.toThrow();

    // Verify NO session was created (UoW rolled back)
    const sessions = await db.select().from(deviceSessions);
    expect(sessions).toHaveLength(0);
  });

  it('locks account after 5 failed OTP attempts', async () => { /* … */ });
});

// E2E test — full HTTP through real stack
describe('POST /auth/mobile/login/verify', () => {
  it('returns 200 with tokens on valid request', async () => {
    const res = await request(app)
      .post('/auth/mobile/login/verify')
      .send({ phone, otp_code: '123456', otp_request_id, device });

    expect(res.status).toBe(200);
    expect(res.body.access_token).toBeDefined();
    expect(res.body.user.permissions_version).toBeDefined();
  });

  it('returns same response on retry with same Idempotency-Key', async () => {
    const idemKey = randomUUID();
    const req1 = await request(app)
      .post('/auth/mobile/login/verify')
      .set('Idempotency-Key', idemKey)
      .send({ … });
    const req2 = await request(app)
      .post('/auth/mobile/login/verify')
      .set('Idempotency-Key', idemKey)
      .send({ … });

    expect(req1.body).toEqual(req2.body);
  });
});
```

**Coverage targets:**

- Mappers: 100% (they're pure, no excuse)
- Schemas: 100% of `superRefine` branches
- Services: 90%+ including failure paths
- Repositories: 80%+ via integration tests
- E2E: critical happy-path + 1 failure path per endpoint

---

## 9. Layer Responsibility Cheat-Sheet

| Layer           | Imports                        | Returns                | Wire format | Pure | Touches DB | Side effects |
| --------------- | ------------------------------ | ---------------------- | ----------- | :--: | :--------: | :----------: |
| Request Schema  | Zod                            | `z.infer<>` type       | snake_case  |  ✓   |     ✗      |      ✗       |
| Request Mapper  | Schema types, domain types     | domain command         | translates  |  ✓   |     ✗      |      ✗       |
| Controller      | Schemas, mappers, services     | `Promise<ResponseDTO>` | translates  |  ✗   |     ✗      |      ✗       |
| Service         | repos, services, EventBus, UoW | domain result          | camelCase   |  ✗   |  via repo  |  ✓ (events)  |
| Repository      | Drizzle schema                 | entity / composite     | camelCase   |  ✗   |     ✓      | writes only  |
| Response Mapper | services types, Response DTO   | Response DTO           | snake_case  |  ✓   |     ✗      |      ✗       |
| Response DTO    | (nothing)                      | —                      | snake_case  |  ✓   |     ✗      |      ✗       |
| Guard           | services, repos                | boolean / throws       | camelCase   |  ✗   |     ✓      |  reads only  |
| Interceptor     | services, context              | `Observable<unknown>`  | camelCase   |  ✗   |     ✓      |  reads only  |
| Event Handler   | services                       | `Promise<void>`        | camelCase   |  ✗   |  via repo  |      ✓       |

---

## 10. Rules at a Glance

### Dependency Rules

- Dependencies point **down and inward only**. No upward imports, ever.
- A lower layer never imports an upper layer.
- A mapper never imports a controller.
- A response DTO never imports anything from the module.
- A repository never imports a service.
- A service never imports a controller, mapper, or DTO.

### Format Rules

- snake_case at the edges (HTTP request and response).
- camelCase everywhere inside (services, repos, types, results).
- The Request Mapper is the only inbound translation point.
- The Response Mapper is the only outbound translation point.
- Mappers list fields explicitly — never spread an entity.

### Architectural Rules

- **One reason to change per file.** Wire-format → Response DTO. Query →
  Repository. Rule → Service. Field-presence → Schema.
- **Services represent use cases.** Split at ~7 methods or ~400 lines.
- **Any write touching ≥2 repositories MUST use a Unit of Work.**
- **Side effects with external systems go through events**, not direct calls.
- **Idempotency keys are honored** on every mutation endpoint.
- **Pagination is cursor-based by default**; offset only for page-numbered admin
  tables that need totals/random access (§4.5).
- **Caching lives outside repositories and business services**, in dedicated
  layer or via decorator.

### Type-Safety Rules

- Every controller handler declares an explicit `Promise<XxxResponse>` return
  type.
- Domain result types live in `types/` and are camelCase only.
- Errors are typed (`AppException` subclasses), never raw `Error`.
- Error codes come from the `ErrorCodes` enum — never inline strings.

### Observability Rules

- Every public service method has `@Traced()`.
- All logs go through the structured `Logger`. No raw `console.log`.
- Domain events increment a metric counter for free graphing.
- Trace ID propagates from HTTP → service → DB.

### Security Rules

- Mappers strip secrets by construction — fields are listed, not spread.
- Guards attach a typed `MobilePrincipal` to `req.user`.
- The full account-status block runs on every authenticated request.
- Transactions never hold locks across external API calls.

---

## 11. Background Jobs

Background workers follow the same layered pattern but are triggered by a scheduler rather than HTTP. They are separate from the HTTP server process (or at least registered in their own NestJS module) so they don't block request handling.

### 11.1 Cron Pattern

```ts
// shared/cron/cron.service.ts
@Injectable()
export class CronService {
  @Cron('0 3 * * *', { name: 'token-cleanup' })
  async tokenCleanup(): Promise<void> {
    await this.tokenCleanupService.deleteExpiredRevokedTokens();
  }

  @Cron('*/5 * * * *', { name: 'subscription-reconcile' })
  async subscriptionReconcile(): Promise<void> {
    await this.subscriptionReconciler.reconcile();
  }

  @Cron('0 2 * * *', { name: 'device-expiry' })
  async deviceExpiry(): Promise<void> {
    await this.deviceExpiryService.expireStaleSlots();
  }
}
```

### 11.2 Overlap Prevention

Crons that mutate shared state MUST prevent concurrent runs. Use a Redis distributed lock (SETNX with TTL):

```ts
async runWithLock(lockKey: string, ttlSeconds: number, fn: () => Promise<void>): Promise<void> {
  const acquired = await this.redis.set(lockKey, '1', 'EX', ttlSeconds, 'NX');
  if (!acquired) {
    this.logger.warn(`[cron] ${lockKey} already running — skipping`);
    return;
  }
  try {
    await fn();
  } finally {
    await this.redis.del(lockKey);
  }
}
```

Jobs that use the distributed lock: `subscription-reconcile`, `device-expiry`. Token cleanup is safe to overlap (deletes by expiry date, no aggregate state).

### 11.3 Active Crons

| Job                      | Schedule        | Lock                    | Description                                                 |
| ------------------------ | --------------- | ----------------------- | ----------------------------------------------------------- |
| `token-cleanup`          | Daily 03:00 UTC | No (idempotent deletes) | Delete expired JTIs from `revoked_tokens`                   |
| `subscription-reconcile` | Every 5 min     | ✅ Redis lock           | Reconcile `account_subscription` status against Razorpay    |
| `device-expiry`          | Daily 02:00 UTC | ✅ Redis lock           | Mark stale device slots as expired in `store_device_access` |

### 11.4 WriteGateService (Rec5 — 📋 Planned)

To enforce offline write-gating at the server level, a `WriteGateService` will centralize the `access_valid_until` check for all mutation endpoints:

```ts
// shared/write-gate/write-gate.service.ts  ← 📋 planned
@Injectable()
export class WriteGateService {
  async assertWriteAllowed(
    accountId: string,
    clientModifiedAt: Date,
  ): Promise<void> {
    const sub = await this.subscriptionCache.get(accountId);
    // Server: reject writes from clients that occurred after access expired
    if (clientModifiedAt > sub.accessValidUntil) {
      throw new ForbiddenException('WRITE_GATE_EXPIRED');
    }
    // Client is responsible for blocking before reaching here:
    // if (Date.now() >= accessValidUntil) → block UI, show renewal prompt
  }
}
```

The `access_valid_until` timestamp is the single scalar that drives all write gating — both on the client (blocks UI proactively) and on the server (rejects writes where `client_modified_at > access_valid_until`). Do not use plan status or feature flags for this check — only `access_valid_until`.

### 11.5 Store Creation — Advisory Lock (F9)

Creating a store atomically creates the account + subscription for new users. Two concurrent requests from the same user (double-tap, network retry) must not create two accounts. Use a Postgres advisory lock keyed on the user's UUID integer hash:

```ts
// In StoreService.createFirstStore():
await this.uow.execute(async (tx) => {
  // Advisory lock: prevents concurrent first-store creation for same user
  // pg_try_advisory_xact_lock is scoped to the transaction — auto-released on commit/rollback
  const lockId = hashToInt64(userId); // deterministic integer from UUID
  const [{ acquired }] = await tx.execute(
    sql`SELECT pg_try_advisory_xact_lock(${lockId}) AS acquired`,
  );
  if (!acquired) {
    throw new ConflictException('STORE_CREATION_IN_PROGRESS');
  }

  // Check again inside the lock — another request may have just committed
  const existingAccount = await this.accountRepo.findByOwner(userId, tx);
  if (existingAccount) {
    throw new ConflictException('ACCOUNT_ALREADY_EXISTS');
  }

  const account = await this.accountRepo.create({ ownerFk: userId }, tx);
  await this.subscriptionRepo.create(
    { accountFk: account.id, plan: 'free' },
    tx,
  );
  const store = await this.storeRepo.create(
    { accountFk: account.id, ...storeData },
    tx,
  );
  await this.storeMemberRepo.create(
    { userFk: userId, storeId: store.id, role: 'owner' },
    tx,
  );

  return { store, account };
});
```
