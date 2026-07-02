# Design Adoption Guide — From Ayphen 3.0 → Retail POS (NestJS)

> Reference source: `docs/ayphen-3.0-architecture.md`
> Target stack: **NestJS · Drizzle ORM · PostgreSQL · TypeScript**
> Date: 2026-06-30 (revised — corrected 24 architectural gaps from original draft)

---

## Table of Contents

1. [Overview & Strategy](#1-overview--strategy)
2. [Tier 1 — Foundation](#2-tier-1--foundation)
   - 2.1 Config Architecture
   - 2.2 Logger Architecture (Pino + structured logs)
   - 2.3 Request ID
   - 2.4 Centralised Error Codes & `AppException`
   - 2.5 Global `ValidationPipe`
   - 2.6 Global Response Interceptor
   - 2.7 Global Exception Filter (complete)
   - 2.8 Pagination Contract (safe sorting)
   - 2.9 Audit Columns
   - 2.10 Soft Delete (`deletedAt` pattern)
   - 2.11 CORS Configuration
   - 2.12 Health Check Endpoint
   - 2.13 API Rate Limiting
   - 2.14 Global String Trim Pipe
   - 2.15 OpenAPI / Swagger UI
3. [Tier 2 — Auth & Structural Correctness](#3-tier-2--auth--structural-correctness)
   - 3.1 JWT Refresh Token with DB Storage (hashed)
   - 3.2 Request Context — `CurrentUser`, `CurrentStoreId`
   - 3.3 Dynamic Permission System (JWT snapshot)
   - 3.4 Explicit Mapper Layer (translation only)
   - 3.5 Transaction Strategy
   - 3.6 Repository Pattern — Stated Decision
   - 3.7 Human-Readable Order Numbers
   - 3.8 Lookup / Master Data Table
   - 3.9 Request-Scoped User Context (`@nestjs/cls`)
   - 3.10 JWT Claims Constants
   - 3.11 Reference Table Columns (`referenceColumns`)
   - 3.12 `ResponseMessages` Constant Object
   - 3.13 Conditional DTO Validation (`@ValidateIf`)
4. [Tier 3 — Take When the Feature Is Needed](#4-tier-3--take-when-the-feature-is-needed)
   - 4.1 Activity Log (with diff, IP, requestId)
   - 4.2 Order State Machine + Optimistic Locking
   - 4.3 Domain Events
   - 4.4 Idempotency
   - 4.5 Scheduled Tasks
   - 4.6 Email via Queue (BullMQ)
   - 4.7 WebSocket with Store Rooms
   - 4.8 Redis Caching
5. [What NOT to Take](#5-what-not-to-take)
6. [Implementation Roadmap](#6-implementation-roadmap)
7. [File Structure Target](#7-file-structure-target)

---

## 1. Overview & Strategy

Ayphen 3.0 is a mature enterprise ERP (Spring Boot, ~1 832 Java source files) covering accounting,
inventory, multi-tenancy, banking, and payments. The Retail POS backend is a narrower domain
(products, orders, payments) but shares the same architectural problems at a smaller scale.

The goal is not to copy Ayphen 3.0 wholesale — that would mean over-engineering a single-store POS.
Extract the **patterns** that solve real problems regardless of scale; skip the patterns that only
exist to serve hundreds of tenants.

> **Tenancy model — read this first.** This design is **single-tenant, multi-store**: one business,
> potentially several store locations, no cross-business tenant isolation. That is why `storeId` is
> threaded through the JWT, the `users`/`products`/`orders` tables, WebSocket rooms, and cache keys
> — to scope data *per store location*, not per tenant. What §5 rejects is **multi-tenancy** (the
> `/companies/{tenantId}/` path prefix, per-tenant feature flags, IAM), not per-store scoping. If
> the deployment is truly a single store with no second location, the `storeId` plumbing can be
> dropped entirely; if multiple locations are in scope, keep it everywhere consistently.

### Decision Framework

| Adopt | Skip |
|-------|------|
| Patterns that cost little now but save pain later | Multi-tenancy path prefixes |
| Patterns every REST API needs regardless of domain | Keycloak / IAM overhead |
| Patterns that enforce correctness at compile time | 49-handler strategy hierarchies |
| Patterns that create a complete audit trail | Integrations unrelated to retail POS |

---

## 2. Tier 1 — Foundation

These have no prerequisites, touch every future feature, and are cheapest to add before the
codebase grows.

---

### 2.1 Config Architecture

**Problem:** Scattered `process.env` calls throughout modules make it impossible to see at a glance
which env vars a service depends on, and there is no compile-time guarantee a required var exists.

**Pattern:** Validate all env vars once at startup via Zod. Expose a typed `AppConfigService` that
every module injects instead of reading `process.env` directly.

```bash
pnpm add zod @nestjs/config --filter @ayphen/backend
```

```ts
// src/config/env.ts
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV:             z.enum(['development', 'test', 'production']).default('development'),
  PORT:                 z.coerce.number().default(3000),
  DATABASE_URL:         z.string().url(),
  JWT_ACCESS_SECRET:    z.string().min(32),
  JWT_REFRESH_SECRET:   z.string().min(32),
  JWT_ACCESS_EXPIRY:    z.string().default('15m'),
  JWT_REFRESH_EXPIRY:   z.string().default('7d'),
  REDIS_URL:            z.string().url().optional(),
  SMTP_HOST:            z.string().optional(),
  SMTP_PORT:            z.coerce.number().default(587),
  SMTP_USER:            z.string().optional(),
  SMTP_PASS:            z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

// Throws at startup if any required var is missing — fails fast, not at runtime
export const env = envSchema.parse(process.env);
```

```ts
// src/config/app-config.service.ts
import { Injectable } from '@nestjs/common';
import { env, Env } from './env';

@Injectable()
export class AppConfigService {
  private readonly c: Env = env;

  get port():               number  { return this.c.PORT; }
  get databaseUrl():        string  { return this.c.DATABASE_URL; }
  get jwtAccessSecret():    string  { return this.c.JWT_ACCESS_SECRET; }
  get jwtRefreshSecret():   string  { return this.c.JWT_REFRESH_SECRET; }
  get jwtAccessExpiry():    string  { return this.c.JWT_ACCESS_EXPIRY; }
  get jwtRefreshExpiry():   string  { return this.c.JWT_REFRESH_EXPIRY; }
  get redisUrl():           string  { return this.c.REDIS_URL ?? ''; }
  get isProduction():       boolean { return this.c.NODE_ENV === 'production'; }
}
```

```ts
// src/config/config.module.ts
import { Global, Module } from '@nestjs/common';
import { AppConfigService } from './app-config.service';

@Global()
@Module({
  providers: [AppConfigService],
  exports:   [AppConfigService],
})
export class AppConfigModule {}
```

Import `AppConfigModule` once in `AppModule`. All other modules inject `AppConfigService` — never
`process.env` directly.

---

### 2.2 Logger Architecture (Pino + structured logs)

**Problem:** NestJS's built-in logger writes unstructured text. Production systems need structured
JSON logs with correlation fields so log queries (`requestId`, `userId`, `storeId`) work in any
log aggregator (Datadog, Loki, CloudWatch).

```bash
pnpm add nestjs-pino pino-http pino-pretty --filter @ayphen/backend
```

```ts
// src/logger/logger.module.ts
import { Global, Module } from '@nestjs/common';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import { env } from '../config/env';

@Global()
@Module({
  imports: [
    PinoLoggerModule.forRoot({
      pinoHttp: {
        level: env.NODE_ENV === 'production' ? 'info' : 'debug',
        transport: env.NODE_ENV !== 'production' ? { target: 'pino-pretty' } : undefined,
        genReqId: (req) => req.headers['x-request-id'] as string,
        customProps: (req) => ({
          requestId: req.headers['x-request-id'],
          userId:    (req as any).user?.id,
          storeId:   (req as any).user?.storeId,
        }),
        serializers: {
          req: (req) => ({ method: req.method, url: req.url }),
          res: (res) => ({ statusCode: res.statusCode }),
        },
      },
    }),
  ],
})
export class LoggerModule {}
```

```ts
// main.ts — use Pino as the app logger
import { Logger } from 'nestjs-pino';
app.useLogger(app.get(Logger));
```

Inject `PinoLogger` (from `nestjs-pino`) everywhere instead of NestJS's `Logger`. Every log line
automatically includes `requestId`, `userId`, and `storeId` from the request.

---

### 2.3 Request ID

**Problem:** Without a stable per-request identifier, you cannot correlate a log line, an activity
entry, and an exception report that all belong to the same HTTP request.

```ts
// src/common/middleware/request-id.middleware.ts
import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';

@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const requestId = (req.headers['x-request-id'] as string) ?? randomUUID();
    req.headers['x-request-id'] = requestId;
    res.setHeader('x-request-id', requestId);
    next();
  }
}
```

```ts
// src/app/app.module.ts — apply before everything else
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
```

The `requestId` is then available in:
- Pino logs (via `customProps` in 2.2)
- Exception filter response body (section 2.7)
- Activity log entries (section 4.1)

---

### 2.4 Centralised Error Codes & `AppException`

**Why:** The mobile app must switch on a stable `errorCode` string, not on English `message` text.
Messages can change with copy edits or i18n; error codes are a contract.

```ts
// src/common/error-codes.ts
export const ErrorCodes = {
  // Auth
  INVALID_CREDENTIALS:        'INVALID_CREDENTIALS',
  TOKEN_EXPIRED:              'TOKEN_EXPIRED',
  TOKEN_INVALID:              'TOKEN_INVALID',
  REFRESH_TOKEN_REVOKED:      'REFRESH_TOKEN_REVOKED',
  ACCOUNT_LOCKED:             'ACCOUNT_LOCKED',

  // Products
  PRODUCT_NOT_FOUND:          'PRODUCT_NOT_FOUND',
  PRODUCT_SKU_EXISTS:         'PRODUCT_SKU_EXISTS',
  PRODUCT_INACTIVE:           'PRODUCT_INACTIVE',
  INSUFFICIENT_STOCK:         'INSUFFICIENT_STOCK',

  // Orders
  ORDER_NOT_FOUND:            'ORDER_NOT_FOUND',
  ORDER_ALREADY_PAID:         'ORDER_ALREADY_PAID',
  ORDER_ALREADY_CANCELLED:    'ORDER_ALREADY_CANCELLED',
  INVALID_ORDER_TRANSITION:   'INVALID_ORDER_TRANSITION',
  EMPTY_ORDER:                'EMPTY_ORDER',
  CONCURRENT_MODIFICATION:    'CONCURRENT_MODIFICATION',
  MISSING_IDEMPOTENCY_KEY:    'MISSING_IDEMPOTENCY_KEY',
  DUPLICATE_IDEMPOTENCY_KEY:  'DUPLICATE_IDEMPOTENCY_KEY',

  // General
  NOT_FOUND:                  'NOT_FOUND',
  VALIDATION_FAILED:          'VALIDATION_FAILED',
  DUPLICATE_ENTRY:            'DUPLICATE_ENTRY',
  FOREIGN_KEY_VIOLATION:      'FOREIGN_KEY_VIOLATION',
  FORBIDDEN:                  'FORBIDDEN',
  UNAUTHORIZED:               'UNAUTHORIZED',
  INTERNAL_ERROR:             'INTERNAL_ERROR',
} as const;

export type ErrorCode = typeof ErrorCodes[keyof typeof ErrorCodes];
```

```ts
// src/common/exceptions/app.exception.ts
import { HttpException, HttpStatus } from '@nestjs/common';
import { ErrorCode } from '../error-codes';

export class AppException extends HttpException {
  constructor(
    public readonly errorCode: ErrorCode,
    message: string,
    statusCode: number = HttpStatus.BAD_REQUEST,
  ) {
    super({ message, errorCode }, statusCode);
  }
}
```

```ts
// Usage anywhere in the service layer:
throw new AppException(ErrorCodes.INSUFFICIENT_STOCK, 'Not enough stock for product ABC', 422);
throw new AppException(ErrorCodes.PRODUCT_NOT_FOUND, `Product ${id} not found`, 404);
```

---

### 2.5 Global `ValidationPipe`

**Problem:** Without a globally configured `ValidationPipe`, DTO validation is not enforced,
unknown properties pass through silently, and type coercion (query strings to numbers) must be done
manually in every controller.

```ts
// src/main.ts
import { ValidationPipe } from '@nestjs/common';
import { AppException } from './common/exceptions/app.exception';
import { ErrorCodes } from './common/error-codes';

app.useGlobalPipes(
  new ValidationPipe({
    whitelist:            true,   // strip unknown properties
    forbidNonWhitelisted: true,   // throw on unknown properties instead of silently stripping
    transform:            true,   // auto-coerce query params / path params to their TS types
    transformOptions:     { enableImplicitConversion: true },
    exceptionFactory: (errors) => {
      const messages = errors.flatMap(e => Object.values(e.constraints ?? {}));
      // Normalise into AppException so exception filter handles it uniformly
      return new AppException(ErrorCodes.VALIDATION_FAILED, messages.join('; '), 422);
    },
  }),
);
```

---

### 2.6 Global Response Interceptor

**Problem:** Having every controller call `ApiResponse.ok(...)` manually:
- Repeats the same boilerplate hundreds of times across the codebase
- Couples controller logic to the response envelope
- Mixes presentation concerns into the controller

**Pattern:** Controllers return plain DTOs (or `void`). A single global interceptor wraps every
successful response into the standard envelope. Use a `@ResponseMessage` decorator to attach a
human-readable message without polluting the return value.

```ts
// src/common/decorators/response-message.decorator.ts
import { SetMetadata } from '@nestjs/common';
export const ResponseMessage = (message: string) => SetMetadata('response_message', message);
```

```ts
// src/common/interceptors/response.interceptor.ts
import {
  Injectable, NestInterceptor, ExecutionContext, CallHandler,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { Response } from 'express';

export interface ApiEnvelope<T> {
  success:    boolean;
  statusCode: number;
  message:    string;
  data:       T | null;
  requestId:  string;
  timestamp:  string;
}

@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<T, ApiEnvelope<T>> {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler<T>): Observable<ApiEnvelope<T>> {
    return next.handle().pipe(
      map((data) => {
        const ctx        = context.switchToHttp();
        const response   = ctx.getResponse<Response>();
        const request    = ctx.getRequest();
        const statusCode = response.statusCode;
        const message    =
          this.reflector.get<string>('response_message', context.getHandler()) ?? 'Success';

        return {
          success:   true,
          statusCode,
          message,
          data:      data ?? null,
          requestId: request.headers['x-request-id'] as string,
          timestamp: new Date().toISOString(),
        };
      }),
    );
  }
}
```

```ts
// src/main.ts — register globally
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { Reflector } from '@nestjs/core';
app.useGlobalInterceptors(new ResponseInterceptor(app.get(Reflector)));
```

**Controller — returns a plain DTO, no envelope code:**

```ts
// ✅ Correct pattern
@Get(':id')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission(Permissions.PRODUCTS_READ)
@ResponseMessage('Product retrieved')
async findOne(@Param('id') id: string): Promise<ProductDto> {
  return this.service.findById(id);     // ← returns ProductDto, not ApiResponse
}

@Post()
@HttpCode(201)
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission(Permissions.PRODUCTS_CREATE)
@ResponseMessage('Product created')
async create(
  @Body() dto: CreateProductDto,
  @CurrentUser() user: RequestUser,
): Promise<ProductDto> {
  return this.service.create(dto, user.id);
}

@Delete(':id')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission(Permissions.PRODUCTS_DELETE)
@ResponseMessage('Product deleted')
async remove(@Param('id') id: string, @CurrentUser() user: RequestUser): Promise<void> {
  await this.service.softDelete(id, user.id);
  // void return — interceptor sets data: null. Status stays 200 so the JSON envelope
  // is actually sent. Do NOT use @HttpCode(204): a 204 No Content response has no body,
  // so the envelope would be stripped and the client would receive an empty response,
  // breaking the "every response is wrapped" contract.
}
```

**What the client always receives:**

```json
{
  "success": true,
  "statusCode": 200,
  "message": "Product retrieved",
  "data": { "id": "...", "name": "...", "price": "19.99" },
  "requestId": "018f4d8e-0c2a-7000-b123-456789abcdef",
  "timestamp": "2026-06-30T10:00:00.000Z"
}
```

---

### 2.7 Global Exception Filter (complete)

**Problem:** The original filter only handled `AppException` and `HttpException`, leaving
class-validator errors, database constraint violations, and unknown errors to produce inconsistent
shapes or expose stack traces.

**All cases that must be handled:**
1. `AppException` — domain errors thrown explicitly
2. `HttpException` with array body — thrown by `ValidationPipe` before `exceptionFactory` applies
3. `HttpException` generic — NestJS guards, pipes, etc.
4. `DatabaseError` from `pg` — constraint violations (unique, FK, not-null, bad UUID)
5. Unknown — log it, return a safe message, never expose stack traces

```ts
// src/common/filters/http-exception.filter.ts
import {
  Catch, ArgumentsHost, ExceptionFilter, HttpException, HttpStatus,
} from '@nestjs/common';
import { Response, Request } from 'express';
import { DatabaseError } from 'pg';
import { AppException } from '../exceptions/app.exception';
import { ErrorCodes } from '../error-codes';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx       = host.switchToHttp();
    const response  = ctx.getResponse<Response>();
    const request   = ctx.getRequest<Request>();
    const requestId = request.headers['x-request-id'] as string;

    let status:    number = HttpStatus.INTERNAL_SERVER_ERROR;
    let errorCode: string = ErrorCodes.INTERNAL_ERROR;
    let message:   string = 'Internal server error';

    if (exception instanceof AppException) {
      status    = exception.getStatus();
      errorCode = exception.errorCode;
      message   = exception.message;

    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();

      if (typeof body === 'object' && body !== null) {
        const b = body as Record<string, unknown>;
        // ValidationPipe produces { message: string[] } before exceptionFactory kicks in
        if (Array.isArray(b['message'])) {
          message   = (b['message'] as string[]).join('; ');
          errorCode = ErrorCodes.VALIDATION_FAILED;
        } else if (typeof b['message'] === 'string') {
          message   = b['message'];
          errorCode = (b['errorCode'] as string) ?? ErrorCodes.INTERNAL_ERROR;
        }
      } else {
        message = exception.message;
      }

    } else if (exception instanceof DatabaseError) {
      // pg driver error — map well-known codes to safe public messages
      switch ((exception as DatabaseError & { code?: string }).code) {
        case '23505': // unique_violation
          status    = HttpStatus.CONFLICT;
          errorCode = ErrorCodes.DUPLICATE_ENTRY;
          message   = 'A record with this value already exists';
          break;
        case '23503': // foreign_key_violation
          status    = HttpStatus.BAD_REQUEST;
          errorCode = ErrorCodes.FOREIGN_KEY_VIOLATION;
          message   = 'Referenced record does not exist';
          break;
        case '23502': // not_null_violation
          status    = HttpStatus.BAD_REQUEST;
          errorCode = ErrorCodes.VALIDATION_FAILED;
          message   = 'A required field is missing';
          break;
        case '22P02': // invalid_text_representation (bad UUID, bad enum value)
          status    = HttpStatus.BAD_REQUEST;
          errorCode = ErrorCodes.VALIDATION_FAILED;
          message   = 'Invalid ID format';
          break;
        default:
          // Do NOT expose constraint names or query text in production
          console.error('[AllExceptionsFilter] Unhandled DatabaseError', exception);
      }
    } else {
      // Unknown — log internally, return generic message
      console.error('[AllExceptionsFilter] Unhandled exception', exception);
    }

    response.status(status).json({
      success:   false,
      statusCode: status,
      message,
      data:      null,
      errorCode,
      requestId,
      timestamp: new Date().toISOString(),
    });
  }
}
```

```ts
// src/main.ts
app.useGlobalFilters(new AllExceptionsFilter());
```

---

### 2.8 Pagination Contract (safe sorting)

Two pagination styles coexist. **Cursor is the default** for this mobile-first app;
offset is the exception for page-numbered admin tables. Pick per endpoint:

| The endpoint is…                                   | Use        | Why                                                     |
|----------------------------------------------------|------------|---------------------------------------------------------|
| A mobile list / infinite scroll / feed             | **Cursor** | append-style UX, stable under concurrent writes         |
| Anything hot, or that can page deep                | **Cursor** | O(log n) via index; offset is O(offset) at depth        |
| Admin table needing page numbers + total counts    | **Offset** | only offset yields `totalPages` / random page access    |
| Small bounded admin list where totals are cheap    | **Offset** | simpler; correctness rarely bites at small N            |

> **Rule of thumb:** if the client renders "Page 3 of 47," use offset. If it renders
> "load more" / infinite scroll, use cursor. When unsure, cursor — it's correct under
> concurrent inserts/deletes, which offset is not (offset skips or repeats rows when
> the underlying set shifts between page loads).

The **sort-column whitelist below applies to BOTH styles** — never pass a raw
`?sortBy` into a query, regardless of pagination approach.

---

#### 2.8.1 Offset pagination — for page-numbered admin tables

**Problem:** `products[req.sortBy]` with an unvalidated query parameter is a column injection
vector — a caller can send `?sortBy=passwordHash` and get results sorted by a sensitive column.
Always whitelist the allowed sort columns explicitly.

```ts
// src/common/pagination.ts
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class PaginationRequest {
  @Type(() => Number)
  @IsInt()
  @Min(0)
  pageNo: number = 0;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize: number = 20;

  @IsOptional()
  @IsString()
  sortBy?: string;

  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortDir: 'asc' | 'desc' = 'desc';
}

export class PaginationResponse<T> {
  content:       T[];
  pageNo:        number;
  pageSize:      number;
  totalElements: number;
  totalPages:    number;
  isFirst:       boolean;
  isLast:        boolean;

  static of<T>(
    content: T[],
    totalElements: number,
    req: PaginationRequest,
  ): PaginationResponse<T> {
    const totalPages = Math.ceil(totalElements / req.pageSize);
    return {
      content,
      pageNo:        req.pageNo,
      pageSize:      req.pageSize,
      totalElements,
      totalPages,
      isFirst: req.pageNo === 0,
      isLast:  req.pageNo >= totalPages - 1,
    };
  }
}
```

**Whitelist sort columns in the service — never pass user input directly:**

```ts
// src/products/products.service.ts
import { asc, desc, isNull, count, sql } from 'drizzle-orm';
import { products } from '../db/schema';

// Explicit whitelist — only these columns are sortable
const PRODUCT_SORT_COLUMNS = {
  createdAt: products.createdAt,
  name:      products.name,
  price:     products.price,
  sku:       products.sku,
  stock:     products.stock,
} as const;

type ProductSortKey = keyof typeof PRODUCT_SORT_COLUMNS;

async findAll(req: PaginationRequest): Promise<PaginationResponse<ProductDto>> {
  const sortKey    = (req.sortBy as ProductSortKey) in PRODUCT_SORT_COLUMNS
    ? req.sortBy as ProductSortKey
    : 'createdAt';
  const sortColumn = PRODUCT_SORT_COLUMNS[sortKey];
  const orderFn    = req.sortDir === 'asc' ? asc : desc;
  const offset     = req.pageNo * req.pageSize;

  const [rows, [{ total }]] = await Promise.all([
    this.db.select().from(products)
      .where(isNull(products.deletedAt))
      .orderBy(orderFn(sortColumn))
      .limit(req.pageSize)
      .offset(offset),
    this.db.select({ total: count() }).from(products).where(isNull(products.deletedAt)),
  ]);

  return PaginationResponse.of(this.mapper.toDtoList(rows), Number(total), req);
}
```

---

#### 2.8.2 Cursor pagination — the default (✅ implemented)

Keyset (cursor) pagination is what most app endpoints should use. It's **stable
under concurrent inserts/deletes** (offset silently skips or repeats rows when the
set shifts between page loads) and stays **O(log n)** at any depth via the sort
index. The trade-off: no `totalElements`/`totalPages`, no random page jumps — which
is exactly fine for "load more" feeds.

Implemented under `apps/backend/src/common/pagination/`:

```ts
// common/pagination/paginated-response.ts
export interface PaginatedResponse<T> {
  data:        T[];
  next_cursor: string | null;  // opaque base64url token; null when no more rows
  has_more:    boolean;
}

export function clampLimit(raw: unknown, { def = 20, max = 100 } = {}): number { /* … */ }
```

```ts
// common/pagination/cursor.ts — opaque, tamper-evident cursor
export interface Cursor { id: string; v: string; }           // v = ISO sort value
export function encodeCursor(id: string, v: string): string; // base64url({id, v})
export function decodeCursor(cursor: string): Cursor;         // throws 400 INVALID_CURSOR
```

The generic `paginateByCursor()` helper does the keyset predicate + `limit + 1`
look-ahead + next-cursor construction, so repositories stay thin:

```ts
// common/pagination/paginate.ts (shape)
paginateByCursor<T>({
  cursor, limit,
  sortColumn,          // DESC-ordered column (e.g. createdAt)
  tieColumn,           // unique tie-breaker (e.g. id)
  fetch,               // (keyset, take) => rows; applies ORDER BY … DESC + limit
  sortValue, idValue,  // extract cursor fields from the last row
}): Promise<{ items: T[]; nextCursor: string | null; hasMore: boolean }>;
```

**Repository** applies the whitelisted sort column and hands the query to the helper:

```ts
// auth-session.repository.ts — real usage
async listActiveSessions(userFk: string, page: { limit: number; cursor?: string }) {
  const base = and(eq(deviceSessions.userFk, userFk), isNull(deviceSessions.revokedAt));
  return paginateByCursor<SessionWithDevice>({
    cursor: page.cursor, limit: page.limit,
    sortColumn: deviceSessions.createdAt,   // whitelisted at the call site
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

**Controller** reads `?limit`/`?cursor`, clamps the limit, and maps to the envelope:

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
  return SessionMapper.toSessionListResponse(page, p.deviceSessionId);
}
```

**Envelope naming — don't mix the two.** Offset returns `content` + `totalElements`
+ `totalPages`; cursor returns `data` + `next_cursor` + `has_more`. A client knows
which it's talking to by the endpoint, and the shapes stay distinct on purpose.

> **When a cursor endpoint accepts a client `?sortBy`** (the sessions list doesn't —
> its sort column is fixed), route it through the same whitelist map from §2.8.1 to
> pick `sortColumn`. Never feed a raw query param into `sortColumn`/`tieColumn`.

---

### 2.9 Audit Columns on Every Table

**Pattern:** A reusable column set spread into every table. Includes `deletedAt` and `deletedBy`
so soft-deleted rows carry a forensic timestamp and actor without an extra table.

```ts
// src/db/audit.ts
import { timestamp, uuid } from 'drizzle-orm/pg-core';

export const auditColumns = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),     // null = active
  createdBy: uuid('created_by'),
  updatedBy: uuid('updated_by'),
  deletedBy: uuid('deleted_by'),
};
```

```ts
// src/common/db-context.ts
export function withAudit(userId: string) {
  return { createdBy: userId, updatedBy: userId };
}

export function withUpdatedBy(userId: string) {
  return { updatedBy: userId, updatedAt: new Date() };
}

export function withSoftDelete(userId: string) {
  return { deletedAt: new Date(), deletedBy: userId, updatedBy: userId };
}
```

```ts
// src/db/schema.ts
import { auditColumns } from './audit';

export const products = pgTable('products', {
  id:      uuid('id').primaryKey().defaultRandom(),
  storeId: uuid('store_id').notNull().references(() => stores.id),  // per-store scoping
  name:    text('name').notNull(),
  sku:     text('sku').notNull(),
  price:   numeric('price', { precision: 10, scale: 2 }).notNull(),
  stock:   integer('stock').notNull().default(0),
  ...auditColumns,
}, (t) => ({
  // SKU is unique within a store, not globally (two stores may reuse the same SKU).
  storeSkuUnique: uniqueIndex('products_store_sku_uq').on(t.storeId, t.sku),
}));

export const orders = pgTable('orders', {
  id:      uuid('id').primaryKey().defaultRandom(),
  storeId: uuid('store_id').notNull().references(() => stores.id),  // per-store scoping
  total:   numeric('total', { precision: 10, scale: 2 }).notNull(),
  status:  text('status', { enum: ['pending', 'paid', 'cancelled', 'refunded'] })
             .notNull().default('pending'),
  version: integer('version').notNull().default(0),  // for optimistic locking
  ...auditColumns,
});

export const orderItems = pgTable('order_items', {
  id:        uuid('id').primaryKey().defaultRandom(),
  orderId:   uuid('order_id').notNull().references(() => orders.id),
  productId: uuid('product_id').notNull().references(() => products.id),
  quantity:  integer('quantity').notNull(),
  unitPrice: numeric('unit_price', { precision: 10, scale: 2 }).notNull(),
  ...auditColumns,
});
```

---

### 2.10 Soft Delete — `deletedAt` Pattern

**Why `deletedAt` over `isActive`:**
- `isActive = false` tells you only that the record is deleted — not *when* or *by whom*
- `deletedAt IS NOT NULL` gives you all three: the fact, the timestamp, and (via `deletedBy`) the actor
- An index on `(deleted_at)` WHERE `deleted_at IS NULL` makes active-record queries fast

```ts
// Filter active records — always use isNull, never isActive
import { isNull, and, eq } from 'drizzle-orm';

db.select().from(products).where(isNull(products.deletedAt))

// "Delete" = stamp deletedAt + deletedBy, never a physical DELETE
async softDelete(id: string, userId: string): Promise<void> {
  const result = await this.db.update(products)
    .set(withSoftDelete(userId))
    .where(and(eq(products.id, id), isNull(products.deletedAt)))
    .returning({ id: products.id });

  if (!result.length) {
    throw new AppException(ErrorCodes.PRODUCT_NOT_FOUND, `Product ${id} not found`, 404);
  }
}
```

**Never expose an endpoint that runs a raw `DELETE FROM` on business tables.**

---

---

### 2.11 CORS Configuration

**Why Ayphen does it:**
Ayphen has a dedicated `CorsConfig.java` that sets allowed origins, HTTP methods, request headers,
and credential support. Without it, browsers block cross-origin requests entirely — the mobile web
app and any dashboard running on a different port or domain cannot reach the API.

**Why the POS needs it:**
The mobile app (React Native / Expo web) and any future web dashboard run on a different origin
than the NestJS backend. Without explicit CORS configuration, every preflight `OPTIONS` request
fails and the API is unreachable from those clients.

**What to add to `src/config/env.ts`:**

```ts
// Add to the Zod schema in src/config/env.ts
CORS_ORIGINS: z.string().default('http://localhost:8081,http://localhost:3000'),
```

**What to add to `.env.example` and `.env.local`:**

```dotenv
CORS_ORIGINS=http://localhost:8081,http://localhost:3000
```

In production, set this to the exact deployed URLs of the mobile web build and admin dashboard
(e.g. `https://pos.myshop.com,https://admin.myshop.com`). Wildcard `*` must never be used in
production when `credentials: true` is set — browsers reject it.

**`src/main.ts` — enable before `app.listen()`:**

```ts
import { env } from './config/env';

// Parse the comma-separated string into an array.
// trim() handles accidental spaces: "http://a.com, http://b.com" → ['http://a.com', 'http://b.com']
const allowedOrigins = env.CORS_ORIGINS.split(',').map(o => o.trim());

app.enableCors({
  origin: (requestOrigin, callback) => {
    // Allow non-browser clients (curl, Postman, server-to-server) where origin is undefined
    if (!requestOrigin || allowedOrigins.includes(requestOrigin)) {
      callback(null, true);
    } else {
      callback(new Error(`CORS: origin '${requestOrigin}' is not allowed`));
    }
  },
  credentials:     true,                                   // allow HttpOnly cookies (refresh token)
  methods:         ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders:  ['Content-Type', 'Authorization', 'x-request-id', 'Idempotency-Key'],
  exposedHeaders:  ['x-request-id'],                       // let client read the request ID header
  maxAge:          86_400,                                  // preflight cached for 24 h
});
```

**Why `credentials: true` matters:**
The refresh token is delivered as an `HttpOnly` cookie (§3.1). The browser only sends cookies on
cross-origin requests when both the server sets `credentials: true` AND the client includes
`{ withCredentials: true }` in the fetch call. Without it, every token refresh silently fails.

**Order in `main.ts`** — CORS must be enabled before the global pipes, guards, and filters are
registered, so it applies to every route including the auth endpoints:

```ts
// ✅ Correct order in main.ts
app.enableCors({ ... });                          // 1. CORS first
app.useGlobalFilters(new AllExceptionsFilter());  // 2. then global filters
app.useGlobalPipes(new ValidationPipe({ ... }));  // 3. then pipes
app.useGlobalInterceptors(...);                   // 4. then interceptors
await app.listen(env.PORT);
```

---

### 2.12 Health Check Endpoint

**Why Ayphen does it:**
Ayphen exposes `/actuator/health`, `/actuator/metrics`, and `/actuator/prometheus` via Spring Boot
Actuator. Docker `HEALTHCHECK`, Kubernetes liveness/readiness probes, and load balancer health
checks all need a reliable `GET /health` that returns `200` only when the application is genuinely
ready to serve traffic — not just that the process is running.

**Why the POS needs it:**
The `Dockerfile` we wrote uses a multi-stage build. Without a health endpoint, Docker has no way
to detect that the container started but the database connection failed. The container shows as
"running" but every request returns 500.

```bash
pnpm add @nestjs/terminus --filter @ayphen/backend
```

**`src/health/health.module.ts`:**

```ts
import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { HealthController } from './health.controller';
import { DrizzleHealthIndicator } from './drizzle-health.indicator';

@Module({
  imports:     [TerminusModule],
  controllers: [HealthController],
  providers:   [DrizzleHealthIndicator],
})
export class HealthModule {}
```

**`src/health/drizzle-health.indicator.ts` — custom Drizzle DB ping:**

`@nestjs/terminus` ships `TypeOrmHealthIndicator` and `PrismaHealthIndicator` but not one for
Drizzle. Write a thin wrapper that runs `SELECT 1` — if it throws, the DB is unreachable.

```ts
import { Injectable } from '@nestjs/common';
import { HealthIndicator, HealthIndicatorResult, HealthCheckError } from '@nestjs/terminus';
import { sql } from 'drizzle-orm';
import { db } from '../db/db.module';

@Injectable()
export class DrizzleHealthIndicator extends HealthIndicator {
  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    try {
      await db.execute(sql`SELECT 1`);
      return this.getStatus(key, true);
    } catch (err) {
      throw new HealthCheckError(
        'Database health check failed',
        this.getStatus(key, false, { message: (err as Error).message }),
      );
    }
  }
}
```

**`src/health/health.controller.ts`:**

```ts
import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckService, MemoryHealthIndicator, DiskHealthIndicator } from '@nestjs/terminus';
import { DrizzleHealthIndicator } from './drizzle-health.indicator';

@Controller('health')                 // → GET /health  (no /api prefix — probes expect bare path)
export class HealthController {
  constructor(
    private readonly health:    HealthCheckService,
    private readonly db:        DrizzleHealthIndicator,
    private readonly memory:    MemoryHealthIndicator,
    private readonly disk:      DiskHealthIndicator,
  ) {}

  @Get()
  @HealthCheck()
  check() {
    return this.health.check([
      // 1. Database connectivity — most critical check
      () => this.db.isHealthy('database'),

      // 2. Process heap — alert before OOM kills the container
      //    250 MB threshold; tune to your container memory limit
      () => this.memory.checkHeap('memory_heap', 250 * 1024 * 1024),

      // 3. RSS (resident set size) — catches memory leaks that heap check misses
      () => this.memory.checkRSS('memory_rss', 512 * 1024 * 1024),

      // 4. Disk space — catches a full volume before writes start failing
      //    Alert when less than 10% of disk is free
      () => this.disk.checkStorage('disk', { thresholdPercent: 0.9, path: '/' }),
    ]);
  }
}
```

**Register in `AppModule`:**

```ts
// src/app/app.module.ts
import { HealthModule } from '../health/health.module';

@Module({
  imports: [
    HealthModule,
    // ... other modules
  ],
})
export class AppModule {}
```

**Why the `/health` path has no `/api` prefix:**
`main.ts` calls `app.setGlobalPrefix('api')` so all routes become `/api/...`. Health probes from
Docker and Kubernetes are configured to hit `/health` (bare), not `/api/health`. Exclude the
`HealthController` from the global prefix:

```ts
// src/main.ts
app.setGlobalPrefix('api', {
  exclude: [{ path: 'health', method: RequestMethod.GET }],
});
```

**Docker `HEALTHCHECK` — add to `Dockerfile`:**

```dockerfile
# In the runner stage, after EXPOSE:
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:3004/health || exit 1
```

**What a healthy response looks like:**

```json
{
  "status": "ok",
  "info": {
    "database":     { "status": "up" },
    "memory_heap":  { "status": "up" },
    "memory_rss":   { "status": "up" },
    "disk":         { "status": "up" }
  },
  "error": {},
  "details": {
    "database":     { "status": "up" },
    "memory_heap":  { "status": "up" },
    "memory_rss":   { "status": "up" },
    "disk":         { "status": "up" }
  }
}
```

**What a degraded response looks like (DB down):**

```json
{
  "status": "error",
  "error": {
    "database": {
      "status": "down",
      "message": "connect ECONNREFUSED 127.0.0.1:5432"
    }
  }
}
```
HTTP status is `503 Service Unavailable` — the load balancer stops routing traffic to this instance.

---

### 2.13 API Rate Limiting

**Why Ayphen does it:**
Ayphen has a global `RateLimitConfig` that caps inbound API requests. Without it, a single
misbehaving client (or an attacker) can saturate the server's thread pool and take down the API
for all terminals.

**Why the POS needs it:**
Two specific threats for a retail POS:
1. A cashier terminal with a bug sends the same payment request in a tight loop.
2. A credential-stuffing attack hammers `POST /api/auth/login` with username/password pairs.

The solution is two separate limits: a **global limit** (100 requests / 60 s per IP) and a
**stricter auth limit** (5 requests / 15 min per IP on login/register).

```bash
pnpm add @nestjs/throttler --filter @ayphen/backend
```

**`src/throttle/throttle.module.ts`:**

```ts
import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { AppConfigService } from '../config/app-config.service';

// Two named throttlers: 'global' and 'auth'.
// Controllers pick which one applies via @Throttle({ auth: { ... } }) or use the global default.
@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      inject:     [AppConfigService],
      useFactory: () => ({
        throttlers: [
          {
            name:  'global',
            ttl:   60_000,    // 60 seconds window
            limit: 100,       // 100 requests per IP per window
          },
          {
            name:  'auth',
            ttl:   900_000,   // 15 minutes window
            limit: 5,         // 5 attempts per IP per window (covers brute-force on login)
          },
        ],
      }),
    }),
  ],
})
export class ThrottleModule {}
```

**Register the guard globally in `main.ts`** so every route is protected without repeating it on
each controller:

```ts
// src/main.ts
import { ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD }      from '@nestjs/core';

// Register as a provider in AppModule, not app.useGlobalGuards() —
// provider registration gives it access to the DI container (needed for ThrottlerGuard).
```

```ts
// src/app/app.module.ts
import { APP_GUARD }    from '@nestjs/core';
import { ThrottlerGuard } from '@nestjs/throttler';
import { ThrottleModule } from '../throttle/throttle.module';

@Module({
  imports:   [ThrottleModule, /* ... */],
  providers: [
    {
      provide:  APP_GUARD,
      useClass: ThrottlerGuard,   // applies the 'global' throttler to every route
    },
  ],
})
export class AppModule {}
```

**Apply the stricter `auth` throttler on login and register:**

```ts
// src/auth/auth.controller.ts
import { Throttle, SkipThrottle } from '@nestjs/throttler';

@Controller('auth')
export class AuthController {

  @Post('login')
  @Throttle({ auth: { ttl: 900_000, limit: 5 } })   // 5 attempts per 15 min
  async login(@Body() dto: LoginDto) { ... }

  @Post('register')
  @Throttle({ auth: { ttl: 900_000, limit: 5 } })
  async register(@Body() dto: RegisterDto) { ... }

  @Post('refresh')
  @Throttle({ auth: { ttl: 900_000, limit: 10 } })   // slightly more generous for refresh
  async refresh() { ... }

  @Post('logout')
  @SkipThrottle()                                      // logout should never be rate-limited
  async logout() { ... }
}
```

**Health check must be exempt:**

```ts
// src/health/health.controller.ts
@SkipThrottle()    // probes run every 30 s — they must not be rate-limited
@Controller('health')
export class HealthController { ... }
```

**What the client receives when rate-limited:**

```json
{
  "success":    false,
  "statusCode": 429,
  "message":    "Too Many Requests",
  "data":       null,
  "errorCode":  "RATE_LIMIT_EXCEEDED",
  "requestId":  "018f4d8e-...",
  "timestamp":  "2026-06-30T10:00:00.000Z"
}
```

Add `RATE_LIMIT_EXCEEDED` to `ErrorCodes`:

```ts
// src/common/error-codes.ts
export const ErrorCodes = {
  // ... existing codes
  RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED',
} as const;
```

And handle `ThrottlerException` in the global exception filter (`src/common/filters/http-exception.filter.ts`):

```ts
import { ThrottlerException } from '@nestjs/throttler';

// Add as the first branch in the catch() method:
if (exception instanceof ThrottlerException) {
  status    = HttpStatus.TOO_MANY_REQUESTS;
  errorCode = ErrorCodes.RATE_LIMIT_EXCEEDED;
  message   = 'Too many requests — please slow down and try again later';
}
```

**Storage backend — upgrade to Redis in production:**

The default `ThrottlerModule` stores counters in-process memory. This means rate limits reset on
every restart and do not share state across multiple server instances. Use the Redis storage
adapter when you have more than one replica:

```bash
pnpm add @nest-lab/throttler-storage-redis ioredis --filter @ayphen/backend
```

```ts
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';

ThrottlerModule.forRootAsync({
  useFactory: (config: AppConfigService) => ({
    throttlers: [ /* same config */ ],
    storage: new ThrottlerStorageRedisService(config.redisUrl),
  }),
  inject: [AppConfigService],
})
```

---

## 3. Tier 2 — Auth & Structural Correctness

---

### 3.1 JWT Refresh Token with DB Storage (hashed)

**Security requirement:** Store `SHA-256(token)` in the database, not the raw token. If the
`refresh_tokens` table is exfiltrated, the attacker receives hashes that cannot be used directly —
the raw token was never persisted. Also capture `deviceId`, `userAgent`, and `ipAddress` so a
stolen-session audit is possible.

```bash
pnpm add @nestjs/passport @nestjs/jwt passport passport-jwt bcrypt @types/bcrypt --filter @ayphen/backend
```

```ts
// src/db/schema.ts
export const users = pgTable('users', {
  id:                  uuid('id').primaryKey().defaultRandom(),
  username:            text('username').notNull().unique(),
  email:               text('email').notNull().unique(),
  passwordHash:        text('password_hash').notNull(),
  firstName:           text('first_name').notNull(),
  lastName:            text('last_name').notNull(),
  role:                text('role', { enum: ['cashier', 'manager', 'admin'] }).notNull().default('cashier'),
  storeId:             uuid('store_id').references(() => stores.id),
  isVerified:          boolean('is_verified').notNull().default(false),
  lastLogin:           timestamp('last_login', { withTimezone: true }),
  failedLoginAttempts: integer('failed_login_attempts').notNull().default(0),
  accountLockedUntil:  timestamp('account_locked_until', { withTimezone: true }),
  ...auditColumns,
});

export const refreshTokens = pgTable('refresh_tokens', {
  id:        uuid('id').primaryKey().defaultRandom(),
  userId:    uuid('user_id').notNull().references(() => users.id),
  tokenHash: text('token_hash').notNull().unique(),  // SHA-256 of the raw token
  jti:       uuid('jti').notNull().unique(),          // JWT ID claim
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  isRevoked: boolean('is_revoked').notNull().default(false),
  deviceId:  text('device_id'),
  userAgent: text('user_agent'),
  ipAddress: text('ip_address'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
```

```ts
// src/auth/auth.service.ts
import { createHash, randomUUID } from 'crypto';

private hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

async login(username: string, password: string, meta: { deviceId?: string; userAgent?: string; ip?: string }) {
  const user = await this.findUserOrThrow(username);
  await this.verifyPassword(user, password);

  const jti          = randomUUID();
  const accessToken  = this.signAccessToken(user);
  const refreshToken = this.signRefreshToken(jti);

  await this.db.insert(refreshTokens).values({
    userId:    user.id,
    tokenHash: this.hashToken(refreshToken),
    jti,
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    deviceId:  meta.deviceId,
    userAgent: meta.userAgent,
    ipAddress: meta.ip,
  });

  // Return the raw refreshToken so the controller can set the HttpOnly cookie.
  // Only the SHA-256 hash is persisted; the raw value never touches the DB.
  return { accessToken, refreshToken, jti };
}

async rotateRefreshToken(incomingToken: string, meta: { userAgent?: string; ip?: string }) {
  const hash   = this.hashToken(incomingToken);
  const stored = await this.db.select().from(refreshTokens)
    .where(and(eq(refreshTokens.tokenHash, hash), eq(refreshTokens.isRevoked, false)))
    .limit(1);

  if (!stored.length || stored[0].expiresAt < new Date()) {
    throw new AppException(ErrorCodes.REFRESH_TOKEN_REVOKED, 'Refresh token is invalid or expired', 401);
  }

  // Revoke the used token (rotation — one-time use)
  await this.db.update(refreshTokens)
    .set({ isRevoked: true })
    .where(eq(refreshTokens.jti, stored[0].jti));

  const user         = await this.findUserById(stored[0].userId);
  const jti          = randomUUID();
  const accessToken  = this.signAccessToken(user);
  const refreshToken = this.signRefreshToken(jti);

  await this.db.insert(refreshTokens).values({
    userId:    user.id,
    tokenHash: this.hashToken(refreshToken),
    jti,
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    userAgent: meta.userAgent,
    ipAddress: meta.ip,
  });

  return { accessToken, refreshToken };
}

async logout(jti: string): Promise<void> {
  await this.db.update(refreshTokens)
    .set({ isRevoked: true })
    .where(eq(refreshTokens.jti, jti));
}
```

**Token flow:**

```
Login:
  → verify password
  → generate accessToken  (15 min, HS256, claims: sub + username + role + storeId + permissions[])
  → generate refreshToken (7 days, HS256, type = "refresh", jti = UUID)
  → INSERT refresh_tokens (userId, SHA-256(refreshToken), jti, expiresAt, deviceId, userAgent, ip)
  → Set-Cookie: refreshToken=...; HttpOnly; SameSite=Lax; Path=/api/auth/refresh
  → Return { accessToken, expiresIn } in body

Refresh:
  → Read refreshToken from cookie
  → Validate JWT signature + expiry
  → Look up SHA-256(token) in refresh_tokens — must not be revoked
  → UPDATE refresh_tokens SET isRevoked = true WHERE jti = ?  (invalidate old)
  → Generate new token pair
  → INSERT new refresh_tokens row
  → Return new accessToken + Set-Cookie

Logout:
  → UPDATE refresh_tokens SET isRevoked = true WHERE jti = ?
  → Clear cookie
```

---

### 3.2 Request Context — `CurrentUser` and `CurrentStoreId`

**Problem:** `request.user` with only `{ id, username, role }` is insufficient for a POS system
that has Store, Location, and permissions baked into every business operation.

**JWT payload** at login — build once, read everywhere:

```ts
// src/auth/interfaces/jwt-payload.interface.ts
export interface JwtPayload {
  sub:         string;    // userId
  username:    string;
  role:        string;
  storeId:     string;
  permissions: string[];  // snapshot at login — see section 3.3
}
```

```ts
// src/auth/interfaces/request-user.interface.ts
export interface RequestUser {
  id:          string;
  username:    string;
  role:        string;
  storeId:     string;
  permissions: string[];
}
```

```ts
// src/auth/decorators/current-user.decorator.ts
import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';
import { RequestUser } from '../interfaces/request-user.interface';

export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): RequestUser =>
    ctx.switchToHttp().getRequest<Request & { user: RequestUser }>().user,
);

export const CurrentStoreId = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): string =>
    ctx.switchToHttp().getRequest<Request & { user: RequestUser }>().user?.storeId,
);
```

```ts
// src/auth/strategies/jwt.strategy.ts
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: AppConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey:    config.jwtAccessSecret,
    });
  }

  validate(payload: JwtPayload): RequestUser {
    return {
      id:          payload.sub,
      username:    payload.username,
      role:        payload.role,
      storeId:     payload.storeId,
      permissions: payload.permissions,
    };
  }
}
```

---

### 3.3 Dynamic Permission System (JWT snapshot)

**Problem:** A static `RolePermissions` constant requires a full redeployment to change any
permission. Permissions should come from the database at login time and be baked into the JWT as a
snapshot. The snapshot is valid for the lifetime of the access token (15 min), which is an
acceptable trade-off at this scale.

```ts
// src/common/permissions.ts
export const Permissions = {
  PRODUCTS_CREATE: 'products:create',
  PRODUCTS_READ:   'products:read',
  PRODUCTS_UPDATE: 'products:update',
  PRODUCTS_DELETE: 'products:delete',

  ORDERS_CREATE:   'orders:create',
  ORDERS_READ:     'orders:read',
  ORDERS_VOID:     'orders:void',
  ORDERS_REFUND:   'orders:refund',

  REPORTS_VIEW:    'reports:view',

  USERS_MANAGE:    'users:manage',
  SETTINGS_MANAGE: 'settings:manage',
} as const;

export type Permission = typeof Permissions[keyof typeof Permissions];
```

```ts
// src/db/schema.ts — roles and their permissions live in the database
export const roles = pgTable('roles', {
  id:   uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull().unique(),
  ...auditColumns,
});

export const rolePermissions = pgTable('role_permissions', {
  roleId:     uuid('role_id').notNull().references(() => roles.id),
  permission: text('permission').notNull(),
});
```

```ts
// src/auth/auth.service.ts — fetch permissions at login
private async buildPermissionSnapshot(userId: string, role: string): Promise<string[]> {
  const rows = await this.db
    .select({ permission: rolePermissions.permission })
    .from(rolePermissions)
    .innerJoin(roles, eq(roles.id, rolePermissions.roleId))
    .where(eq(roles.name, role));
  return rows.map(r => r.permission);
}

// In login():
const permissions  = await this.buildPermissionSnapshot(user.id, user.role);
const accessToken  = this.jwtService.sign({
  sub: user.id, username: user.username, role: user.role,
  storeId: user.storeId, permissions,
});
```

```ts
// src/auth/decorators/require-permission.decorator.ts
import { SetMetadata } from '@nestjs/common';
import { Permission } from '../../common/permissions';
export const RequirePermission = (...permissions: Permission[]) =>
  SetMetadata('permissions', permissions);

// src/auth/guards/permissions.guard.ts
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    // getAllAndOverride checks BOTH the handler and the controller class, so a class-level
    // @RequirePermission is honoured (reflector.get on the handler alone would miss it).
    const required = this.reflector.getAllAndOverride<Permission[]>('permissions', [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!required?.length) return true;
    const { user } = ctx.switchToHttp().getRequest<{ user: RequestUser }>();
    return required.every(p => user.permissions.includes(p));
  }
}
```

**Controller usage:**

```ts
@Delete(':id')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission(Permissions.PRODUCTS_DELETE)
@ResponseMessage('Product deleted')
async remove(@Param('id') id: string, @CurrentUser() user: RequestUser): Promise<void> {
  await this.service.softDelete(id, user.id);
  // 200 (default) — keeps the JSON envelope. See §2.6: @HttpCode(204) would drop the body.
}
```

---

### 3.4 Explicit Mapper Layer (translation only)

**Rule:** A mapper does type translation between a DB row and a DTO. It contains no formatting
logic, no currency conversion, no decisions. When the DB schema changes, only the mapper updates —
controllers and services never see raw column names.

Note: Drizzle returns `numeric` columns as `string` from `node-postgres`. Passing that string
through to the DTO is type translation, not business logic.

```ts
// src/products/products.mapper.ts
import { Injectable } from '@nestjs/common';
import { products } from '../db/schema';
import { ProductDto } from './dto/product.dto';
import { CreateProductDto } from './dto/create-product.dto';

type ProductRow    = typeof products.$inferSelect;
type ProductInsert = typeof products.$inferInsert;

@Injectable()
export class ProductsMapper {
  toDto(row: ProductRow): ProductDto {
    return {
      id:        row.id,
      name:      row.name,
      sku:       row.sku,
      price:     row.price,       // string from Drizzle numeric — pass through as-is
      stock:     row.stock,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  toDtoList(rows: ProductRow[]): ProductDto[] {
    return rows.map(r => this.toDto(r));
  }

  toInsert(dto: CreateProductDto, userId: string): ProductInsert {
    return {
      name:  dto.name,
      sku:   dto.sku,
      price: String(dto.price),   // DTO receives number; DB expects string for numeric column
      stock: dto.stock ?? 0,
      ...withAudit(userId),
    };
  }
}
```

Register `ProductsMapper` as a provider in the module; inject it into the service.
**Never call `.toDto()` from a controller.**

---

### 3.5 Transaction Strategy

**Problem:** Order creation touches three tables (orders, order_items, products stock). Without a
transaction, a partial failure leaves the DB in an inconsistent state — items created but order not,
or stock decremented but order rolled back.

**Rule:** Any operation that writes to more than one table must be wrapped in `db.transaction()`.

```ts
// src/orders/orders.service.ts
async createOrder(dto: CreateOrderDto, userId: string): Promise<OrderDto> {
  if (!dto.items.length) {
    throw new AppException(ErrorCodes.EMPTY_ORDER, 'Order must contain at least one item', 422);
  }

  return this.db.transaction(async (tx) => {
    // 1. Create the order record
    const [order] = await tx.insert(orders).values({
      total:  String(dto.items.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0)),
      status: 'pending',
      ...withAudit(userId),
    }).returning();

    // 2. Create order items
    await tx.insert(orderItems).values(
      dto.items.map(item => ({
        orderId:   order.id,
        productId: item.productId,
        quantity:  item.quantity,
        unitPrice: String(item.unitPrice),
        ...withAudit(userId),
      })),
    );

    // 3. Decrement stock atomically — fail if any product has insufficient stock
    for (const item of dto.items) {
      const result = await tx.update(products)
        .set({
          stock: sql`${products.stock} - ${item.quantity}`,
          ...withUpdatedBy(userId),
        })
        .where(and(
          eq(products.id, item.productId),
          gte(products.stock, item.quantity),   // prevents negative stock
          isNull(products.deletedAt),
        ))
        .returning({ id: products.id });

      if (!result.length) {
        throw new AppException(
          ErrorCodes.INSUFFICIENT_STOCK,
          `Insufficient stock for product ${item.productId}`,
          422,
        );
        // tx.transaction() auto-rolls back when an exception is thrown
      }
    }

    return this.mapper.toDto(order);
  });
}
```

---

### 3.6 Repository Pattern — Stated Decision

**The choice for this codebase:** Services call Drizzle directly. No repository layer.

**Why:** A repository layer (Service → Repository → Drizzle) adds value when:
- Multiple services share the same query logic (prevent duplication)
- You need to swap the data layer (e.g., Drizzle → Prisma) without touching service logic
- You want to mock database calls in unit tests without an actual DB

For a retail POS with few entities and Drizzle's already-composable query builder, the extra layer
adds files without adding isolation value that the test setup doesn't already handle.

**If you change this decision later:** Extract one `ProductsRepository` first, verify the pattern
fits, then apply to other modules. Do not add a repository layer to every module preemptively.

---

### 3.7 Human-Readable Order Numbers

**Why Ayphen does it:**
Ayphen has a `TransactionPrefixController` that auto-generates document numbers like `INV-2024-0001`,
`PO-2024-0042`, `SO-2024-0007`. These are the numbers printed on invoices and purchase orders —
the format that accountants, auditors, and customers actually reference.

**Why the POS needs it:**
A receipt that shows `Order #018f4d8e-0c2a-7000-8000-5a3f9b2c1d4e` is unusable in a retail
environment. Cashiers read order numbers aloud, customers quote them for returns, and managers
search by them in daily reports. The UUID stays as the internal primary key (never exposed) while
a short, structured `orderNumber` becomes the user-facing identifier.

**Drizzle schema — `src/db/schema/sequences.schema.ts`:**

```ts
import { pgTable, text, integer } from 'drizzle-orm/pg-core';

// One row per document type. The counter is incremented inside a serialized transaction.
export const sequences = pgTable('sequences', {
  type:    text('type').primaryKey(),        // 'order' | 'refund' | 'adjustment'
  prefix:  text('prefix').notNull(),         // 'ORD' | 'REF' | 'ADJ'
  counter: integer('counter').notNull().default(0),
  year:    integer('year').notNull(),        // resets to 0 each calendar year
});
```

Seed the table on first migration:

```sql
INSERT INTO sequences (type, prefix, counter, year) VALUES
  ('order',      'ORD', 0, 2026),
  ('refund',     'REF', 0, 2026),
  ('adjustment', 'ADJ', 0, 2026);
```

**`src/common/services/sequence.service.ts`:**

```ts
import { Injectable }  from '@nestjs/common';
import { db }          from '../../db/db.module';
import { sequences }   from '../../db/schema/sequences.schema';
import { eq }          from 'drizzle-orm';
import { sql }         from 'drizzle-orm';

@Injectable()
export class SequenceService {

  async nextOrderNumber(type: 'order' | 'refund' | 'adjustment'): Promise<string> {
    return db.transaction(async (tx) => {
      const currentYear = new Date().getFullYear();

      // If the year has rolled over, reset the counter to 0 atomically.
      // This runs inside the same transaction as the increment — no separate reset step.
      const [row] = await tx
        .select()
        .from(sequences)
        .where(eq(sequences.type, type))
        .for('update');              // row-level lock — prevents concurrent increments

      if (!row) throw new Error(`Unknown sequence type: ${type}`);

      let nextCounter: number;
      if (row.year !== currentYear) {
        // New year — reset to 1
        nextCounter = 1;
        await tx
          .update(sequences)
          .set({ counter: 1, year: currentYear })
          .where(eq(sequences.type, type));
      } else {
        nextCounter = row.counter + 1;
        await tx
          .update(sequences)
          .set({ counter: nextCounter })
          .where(eq(sequences.type, type));
      }

      // Format: ORD-2026-0001 (zero-padded to 4 digits)
      return `${row.prefix}-${currentYear}-${String(nextCounter).padStart(4, '0')}`;
    });
  }
}
```

**Why `SELECT ... FOR UPDATE` (row-level lock):**
Without it, two concurrent requests both read `counter = 5`, both compute `nextCounter = 6`, and
both write `6` — resulting in a duplicate order number. The `FOR UPDATE` lock serializes the
increment: the second request blocks until the first transaction commits, then reads `counter = 6`
and writes `7`.

**Add `orderNumber` to the orders schema:**

```ts
// src/db/schema/orders.schema.ts
export const orders = pgTable('orders', {
  id:          uuid('id').primaryKey().defaultRandom(),
  orderNumber: text('order_number').notNull().unique(),   // ORD-2026-0001
  storeId:     uuid('store_id').notNull().references(() => stores.id),
  // ... rest of columns
});
```

**Usage in `OrdersService.create()`:**

```ts
async create(dto: CreateOrderDto, storeId: string): Promise<OrderDto> {
  const orderNumber = await this.sequenceService.nextOrderNumber('order');

  const [order] = await db.insert(orders).values({
    orderNumber,
    storeId,
    // ...dto fields
  }).returning();

  return orderMapper.toDto(order);
}
```

**Return `orderNumber` in every order DTO:**

```ts
export class OrderDto {
  id:          string;   // UUID — for internal linking, not shown to cashier
  orderNumber: string;   // ORD-2026-0001 — shown on receipts, used in search
  // ... other fields
}
```

**Register `SequenceService` as a shared provider in `CommonModule`** so every domain module
(`OrdersModule`, `RefundsModule`) can inject it without circular imports.

---

### 3.8 Lookup / Master Data Table

**Why Ayphen does it:**
Ayphen maintains a `lookup` table — a general-purpose key-value store for reference data
(dropdown options, status labels, configurable enumerations). Instead of hardcoding enums like
`CASH | CARD | QR_CODE` in application code, the shop owner can add a new payment method from
the admin UI without a code deployment.

**Why the POS needs it:**
Hardcoded enums break on day one in any market with local payment methods:
- India: `UPI`, `PhonePe`, `Paytm`, `NEFT`
- SEA: `GrabPay`, `GoPay`, `OVO`, `PromptPay`
- A small shop that has a standing account with a supplier: `CREDIT_ACCOUNT`

The lookup table decouples "what values are valid" from "what the application source says", making
the system configurable without code changes.

**Drizzle schema — `src/db/schema/lookups.schema.ts`:**

```ts
import { pgTable, uuid, text, integer, boolean, uniqueIndex } from 'drizzle-orm/pg-core';
import { auditColumns } from './audit.schema';
import { stores }       from './stores.schema';

export const lookups = pgTable('lookups', {
  id:        uuid('id').primaryKey().defaultRandom(),

  // storeId = null means it's a system-wide lookup (shared across all stores).
  // storeId = <uuid> means it's a store-specific extension (store adds its own payment methods).
  storeId:   uuid('store_id').references(() => stores.id),

  category:  text('category').notNull(),   // 'payment_method' | 'product_category' | 'tax_code' | 'unit'
  code:      text('code').notNull(),        // 'CASH' | 'UPI' | 'CARD' — used in code and DB FKs
  label:     text('label').notNull(),       // 'Cash' | 'UPI' | 'Credit / Debit Card' — shown in UI
  metadata:  jsonb('metadata'),             // optional extra data: { icon: 'cash', requiresRef: false }
  sortOrder: integer('sort_order').notNull().default(0),
  isActive:  boolean('is_active').notNull().default(true),

  ...auditColumns,
}, (t) => ({
  // A store cannot have two lookups with the same category + code.
  // Using COALESCE so the unique index works even when storeId is NULL (system-wide).
  uniq: uniqueIndex('lookups_store_cat_code_uq').on(t.storeId, t.category, t.code),
}));
```

**Seed system-wide lookups in the initial migration:**

```ts
// src/db/seeds/lookups.seed.ts
export const systemLookups = [
  // Payment methods
  { category: 'payment_method', code: 'CASH',   label: 'Cash',           sortOrder: 1 },
  { category: 'payment_method', code: 'CARD',   label: 'Credit / Debit Card', sortOrder: 2 },
  { category: 'payment_method', code: 'UPI',    label: 'UPI',            sortOrder: 3 },

  // Product categories (initial set — store can extend)
  { category: 'product_category', code: 'BEVERAGES', label: 'Beverages', sortOrder: 1 },
  { category: 'product_category', code: 'SNACKS',    label: 'Snacks',    sortOrder: 2 },
  { category: 'product_category', code: 'DAIRY',     label: 'Dairy',     sortOrder: 3 },

  // Units of measure
  { category: 'unit', code: 'PCS',  label: 'Pieces',    sortOrder: 1 },
  { category: 'unit', code: 'KG',   label: 'Kilograms', sortOrder: 2 },
  { category: 'unit', code: 'LTR',  label: 'Litres',    sortOrder: 3 },

  // Tax codes
  { category: 'tax_code', code: 'GST_0',  label: 'GST 0%',  sortOrder: 1 },
  { category: 'tax_code', code: 'GST_5',  label: 'GST 5%',  sortOrder: 2 },
  { category: 'tax_code', code: 'GST_12', label: 'GST 12%', sortOrder: 3 },
  { category: 'tax_code', code: 'GST_18', label: 'GST 18%', sortOrder: 4 },
];
```

**`src/lookups/lookups.service.ts`:**

```ts
@Injectable()
export class LookupsService {

  // Fetch all active lookups for a category, merging system-wide and store-specific.
  // Store-specific entries extend (not replace) system-wide entries.
  async findByCategory(category: string, storeId: string): Promise<LookupDto[]> {
    const rows = await db
      .select()
      .from(lookups)
      .where(
        and(
          eq(lookups.category, category),
          eq(lookups.isActive, true),
          or(
            isNull(lookups.storeId),            // system-wide entries
            eq(lookups.storeId, storeId),       // store-specific entries
          ),
        ),
      )
      .orderBy(asc(lookups.sortOrder));

    return rows.map(lookupMapper.toDto);
  }

  // Validate that a code is a valid member of a category.
  // Used by other services before saving: e.g., OrdersService validates paymentMethod.
  async validateCode(category: string, code: string, storeId: string): Promise<void> {
    const [row] = await db
      .select({ id: lookups.id })
      .from(lookups)
      .where(
        and(
          eq(lookups.category, category),
          eq(lookups.code, code),
          eq(lookups.isActive, true),
          or(isNull(lookups.storeId), eq(lookups.storeId, storeId)),
        ),
      )
      .limit(1);

    if (!row) {
      throw new AppException(
        ErrorCodes.INVALID_LOOKUP_CODE,
        `'${code}' is not a valid ${category}`,
        HttpStatus.BAD_REQUEST,
      );
    }
  }
}
```

**`src/lookups/lookups.controller.ts`:**

```ts
@Controller('lookups')
@UseGuards(JwtAuthGuard)
export class LookupsController {

  // GET /api/lookups/payment_method  → returns all active payment methods for the store
  @Get(':category')
  findByCategory(
    @Param('category') category: string,
    @CurrentStoreId() storeId: string,
  ) {
    return this.lookupsService.findByCategory(category, storeId);
  }

  // POST /api/lookups  → store-admin adds a custom payment method for their store
  @Post()
  @RequirePermission('lookups:create')
  create(@Body() dto: CreateLookupDto, @CurrentStoreId() storeId: string) {
    return this.lookupsService.create({ ...dto, storeId });
  }

  // PATCH /api/lookups/:id  → rename or reorder a store-specific lookup
  @Patch(':id')
  @RequirePermission('lookups:update')
  update(@Param('id') id: string, @Body() dto: UpdateLookupDto, @CurrentStoreId() storeId: string) {
    return this.lookupsService.update(id, dto, storeId);
  }
}
```

**Integration with orders — validate `paymentMethod` on order creation:**

```ts
// src/orders/orders.service.ts
async create(dto: CreateOrderDto, storeId: string) {
  // Validate that the payment method code is active for this store before touching the DB.
  await this.lookupsService.validateCode('payment_method', dto.paymentMethod, storeId);

  // ... rest of order creation
}
```

**Integration with products — `categoryCode` FK to lookups:**

```ts
// src/db/schema/products.schema.ts
export const products = pgTable('products', {
  // ...
  categoryCode: text('category_code').notNull(),  // validated against lookups.code where category='product_category'
  unit:         text('unit').notNull(),            // validated against lookups.code where category='unit'
  taxCode:      text('tax_code').notNull(),        // validated against lookups.code where category='tax_code'
});
```

**Why not a Postgres `ENUM` type:**
Postgres native `ENUM` types require an `ALTER TYPE` DDL migration each time a new value is added.
The lookup table pattern allows the shop owner to add `SWIPE_MACHINE` as a payment method from the
admin UI at 9 PM on a Friday without touching the database schema or redeploying the application.

**Caching consideration:**
Lookups are read frequently (every order form load, every product save) and change rarely. Apply the
Redis caching pattern from §4.8:

```ts
async findByCategory(category: string, storeId: string): Promise<LookupDto[]> {
  const cacheKey = `lookups:${storeId}:${category}`;
  const cached   = await this.redis.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const result = await /* DB query */;
  await this.redis.set(cacheKey, JSON.stringify(result), 'EX', 3600);  // 1 h TTL
  return result;
}
// Invalidate on create/update/soft-delete: await this.redis.del(`lookups:${storeId}:${category}`)
```

---

### 2.14 Global String Trim Pipe

**Source:** `TrimStringDeserializer.java` + `GlobalBindingHandler.java`

**Problem:** Without automatic trimming, `"  Coca Cola  "` hits the DB with leading and trailing
spaces — it breaks exact-match queries (`WHERE sku = 'COKE'` misses `' COKE'`), looks wrong on
receipts, and causes duplicate-detection to miss obvious duplicates like `"  Cash  "` vs `"Cash"`.
Ayphen fixes this at the Jackson deserialization layer so every string value is trimmed before any
validation or DB write.

**Why empty string becomes `null`, not `""`:** Ayphen uses `StringTrimmerEditor(true)` — the
`true` enables empty-to-null conversion. A field that is optional and submitted as `""` (e.g. an
optional `notes` field left blank in a form) should be stored as `NULL`, not `""`. Without this,
you get inconsistent nullable fields where some rows have `""` and others have `NULL` for the same
semantic meaning.

```bash
# No package needed — pure NestJS pipe
```

```ts
// src/common/pipes/trim-string.pipe.ts
import { Injectable, PipeTransform } from '@nestjs/common';

@Injectable()
export class TrimStringPipe implements PipeTransform {
  transform(value: unknown): unknown {
    if (typeof value === 'string') return value.trim() || null;   // "" → null
    if (value !== null && typeof value === 'object') {
      return this.trimObject(value as Record<string, unknown>);
    }
    return value;
  }

  private trimObject(obj: Record<string, unknown>): Record<string, unknown> {
    for (const key of Object.keys(obj)) {
      const v = obj[key];
      if (typeof v === 'string') {
        obj[key] = v.trim() || null;
      } else if (v !== null && typeof v === 'object') {
        obj[key] = this.trimObject(v as Record<string, unknown>);
      }
    }
    return obj;
  }
}
```

**Wire in `main.ts` — always before `ValidationPipe`** so the validator sees already-trimmed
values (otherwise `@IsNotEmpty()` passes on `"   "` before it is trimmed to `null`):

```ts
// src/main.ts
app.useGlobalPipes(
  new TrimStringPipe(),        // 1. trim + empty → null  (from Ayphen's TrimStringDeserializer)
  new ValidationPipe({ ... }), // 2. validate trimmed values
);
```

**Correct order matters:** If `ValidationPipe` runs before `TrimStringPipe`, a DTO field marked
`@IsNotEmpty()` with value `"   "` would pass validation (the string is not empty) — the trim
happens after the guard has already passed. With `TrimStringPipe` first, `"   "` becomes `null`
before the validator sees it, and `@IsNotEmpty()` correctly rejects it.

---

### 2.15 OpenAPI / Swagger UI

**Source:** `SwaggerConfig.java`

**Problem:** The mobile (Expo) team and any future integration consumers cannot know the exact
request/response shapes without reading NestJS source code. Ayphen exposes a JWT-authenticated
Swagger UI at `/swagger-ui.html` and a machine-readable spec at `/v3/api-docs`. Without this,
every endpoint shape has to be communicated out-of-band (Notion, Postman collections, verbal).

**Why it is a gap:** `@nestjs/swagger` does not appear anywhere in the design doc's original
sections 1–4. It is not optional — every API that serves a mobile client needs a spec.

```bash
pnpm add @nestjs/swagger --filter @ayphen/backend
```

**`src/main.ts` — add after exception filter registration, before `app.listen()`:**

```ts
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

const docConfig = new DocumentBuilder()
  .setTitle('Ayphen Retail POS')
  .setDescription('REST API for the retail point-of-sale backend')
  .setVersion('1.0')
  .addServer(`http://localhost:${env.PORT}`, 'Local dev')
  .addBearerAuth(
    {
      type:         'http',
      scheme:       'bearer',
      bearerFormat: 'JWT',
      name:         'Authorization',
      in:           'header',
    },
    'access-token',   // ← reference name used in @ApiBearerAuth('access-token')
  )
  .build();

const document = SwaggerModule.createDocument(app, docConfig);
SwaggerModule.setup('docs', app, document, {
  swaggerOptions: { persistAuthorization: true },   // token survives browser refresh
});
// → GET /docs          (Swagger UI)
// → GET /docs-json     (OpenAPI JSON spec)
```

**Exclude `/docs` from the global `api` prefix and from rate limiting:**

```ts
// src/main.ts — update setGlobalPrefix
app.setGlobalPrefix('api', {
  exclude: [
    { path: 'health', method: RequestMethod.GET },
    { path: 'docs',   method: RequestMethod.GET },
    { path: 'docs/(.*)', method: RequestMethod.GET },  // Swagger assets
  ],
});
```

```ts
// Swagger UI serves static assets — ThrottlerGuard would rate-limit the JS/CSS
// Add @SkipThrottle() on the docs routes by excluding the path in ThrottleModule,
// or accept that Swagger UI assets may hit the rate limit (they won't in practice
// since the UI is only open during development, not in production traffic).
```

**Apply `@ApiTags` and `@ApiBearerAuth` to every controller — the discipline Ayphen enforces:**

```ts
// src/products/products.controller.ts
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse } from '@nestjs/swagger';

@ApiTags('Products')
@ApiBearerAuth('access-token')   // ← matches the name in DocumentBuilder.addBearerAuth()
@Controller('products')
export class ProductsController {

  @Get(':id')
  @ApiOperation({ summary: 'Get product by ID' })
  @ApiResponse({ status: 200, description: 'Product retrieved successfully' })
  @ApiResponse({ status: 404, description: 'Product not found — PRODUCT_NOT_FOUND' })
  @ApiResponse({ status: 401, description: 'No / invalid token — UNAUTHORIZED' })
  findOne(@Param('id') id: string): Promise<ProductDto> {
    return this.service.findById(id);
  }

  @Post()
  @ApiOperation({ summary: 'Create a new product' })
  @ApiResponse({ status: 201, description: 'Product created' })
  @ApiResponse({ status: 409, description: 'SKU already exists — DUPLICATE_ENTRY' })
  @ApiResponse({ status: 422, description: 'Validation error — VALIDATION_FAILED' })
  create(@Body() dto: CreateProductDto): Promise<ProductDto> {
    return this.service.create(dto);
  }
}
```

**Annotate DTOs with `@ApiProperty` for request body documentation:**

```ts
// src/products/dto/create-product.dto.ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateProductDto {
  @ApiProperty({ example: 'Coca-Cola 330ml' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({ example: 'COKE-330' })
  @IsString()
  @IsNotEmpty()
  sku: string;

  @ApiProperty({ example: 1.99, description: 'Unit price in store currency' })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  price: number;

  @ApiPropertyOptional({ example: 50, default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  stock?: number;
}
```

**What the team gets:** `GET /docs` opens a fully interactive UI where developers can paste a JWT,
expand any endpoint, see exact request/response shapes, and test it without Postman. The
`/docs-json` URL can be imported into Postman, Insomnia, or used to generate a typed API client
for the mobile app via `openapi-typescript`.

---

### 3.9 Request-Scoped User Context (`@nestjs/cls`)

**Source:** `UserContextHolder.java` (ThreadLocal) + `BaseEntityListener.java` (auto-fills
`createdBy`/`modifiedBy` on every `@PrePersist` / `@PreUpdate`)

**The full Ayphen loop:**

```
JWT filter validates token
  → sets userContextHolder.setCurrentUser(user)      // ThreadLocal<User>
  → request runs
  → JPA fires BaseEntityListener on every entity save
  → BaseEntityListener calls userContextHolder.getCurrentUser()
  → auto-stamps createdBy / modifiedBy on every row
  → finally: userContextHolder.clear()               // prevents memory leak between threads
```

**Why this matters for the POS:** Once the call stack grows to
`Controller → Service → ActivityLogService`, passing `userId` as a parameter through every layer
becomes maintenance noise. Every new service method needs a `userId` argument even when it is
conceptually a cross-cutting concern, not domain logic. `@nestjs/cls` (Continuation Local Storage)
is the Node.js equivalent of `ThreadLocal<T>` — it stores values scoped to a single async request
context and cleans up automatically when the request completes. The `finally: clear()` in Ayphen's
filter confirms that cleanup is non-negotiable; `@nestjs/cls` enforces this automatically.

**Install:**

```bash
pnpm add @nestjs/cls --filter @ayphen/backend
```

**Register globally in `AppModule`:**

```ts
// src/app/app.module.ts
import { ClsModule } from 'nestjs-cls';

@Module({
  imports: [
    ClsModule.forRoot({
      global:     true,
      middleware: {
        mount:    true,          // auto-mount on every incoming request
        setup:    (cls, req) => {
          // Populate requestId from the header set by RequestIdMiddleware.
          // userId and storeId are pushed in by JwtAuthGuard after token validation.
          cls.set('requestId', req.headers['x-request-id'] as string);
          cls.set('ipAddress', req.ip);
          cls.set('userAgent', req.headers['user-agent'] ?? '');
        },
      },
    }),
    // ... other modules
  ],
})
export class AppModule {}
```

**Push user into CLS after JWT validation:**

```ts
// src/auth/guards/jwt-auth.guard.ts
import { Injectable, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ClsService } from 'nestjs-cls';
import { RequestUser } from '../interfaces/request-user.interface';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly cls: ClsService) { super(); }

  handleRequest<TUser>(err: unknown, user: TUser): TUser {
    if (err || !user) throw (err as Error) || new UnauthorizedException();
    const u = user as RequestUser;
    this.cls.set('userId',  u.id);
    this.cls.set('storeId', u.storeId);
    return user;
  }
}
```

**Read user context in any service — no parameter threading:**

```ts
// src/products/products.service.ts
import { Inject, Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';

@Injectable()
export class ProductsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase,
    private readonly cls: ClsService,
  ) {}

  async softDelete(id: string): Promise<void> {
    const userId = this.cls.get<string>('userId');    // ← no parameter, reads from context

    const result = await this.db.update(products)
      .set(withSoftDelete(userId))
      .where(and(eq(products.id, id), isNull(products.deletedAt)))
      .returning({ id: products.id });

    if (!result.length) {
      throw new AppException(ErrorCodes.PRODUCT_NOT_FOUND, `Product ${id} not found`, 404);
    }
  }
}
```

**What CLS stores per request:**

| Key | Set by | Used by |
|-----|--------|---------|
| `requestId` | `ClsModule.setup` (from `x-request-id` header) | ActivityLogService, exception filter |
| `ipAddress` | `ClsModule.setup` | ActivityLogService |
| `userAgent` | `ClsModule.setup` | ActivityLogService, refreshToken row |
| `userId` | `JwtAuthGuard.handleRequest` | Any service that writes to the DB |
| `storeId` | `JwtAuthGuard.handleRequest` | Any service that scopes queries by store |

**Take this before implementing the activity log (§4.1).** Without CLS, `ActivityLogService.log()`
needs `userId`, `requestId`, `ipAddress`, and `storeId` as parameters — which means every calling
service needs to pass them, and every calling controller needs to extract them from the request.

---

### 3.10 JWT Claims Constants

**Source:** `JwtClaims.java`

**Problem:** JWT claim names (`'sub'`, `'storeId'`, `'permissions'`) appear as magic strings in
`JwtStrategy.validate()`, `AuthService.signAccessToken()`, and any middleware that inspects the
token. If a claim name changes (e.g. `'storeId'` → `'store_id'`), you must grep for it across
multiple files and hope you haven't missed one.

**Pattern:** A single constant file. One change, zero misses.

```ts
// src/auth/constants/jwt-claims.ts
export const JwtClaims = {
  SUBJECT:      'sub',          // userId — standard JWT claim
  USERNAME:     'username',
  ROLE:         'role',
  STORE_ID:     'storeId',
  PERMISSIONS:  'permissions',  // string[] baked in at login (JWT snapshot, see §3.3)
  TOKEN_TYPE:   'type',         // 'access' | 'refresh' — guards against using a refresh token
                                // as an access token
  JTI:          'jti',          // JWT ID — used to revoke individual refresh tokens (§3.1)
} as const;
```

**Usage in `JwtStrategy`:**

```ts
// src/auth/strategies/jwt.strategy.ts
import { JwtClaims } from '../constants/jwt-claims';

validate(payload: Record<string, unknown>): RequestUser {
  // Guard: reject refresh tokens used as access tokens
  if (payload[JwtClaims.TOKEN_TYPE] !== 'access') {
    throw new UnauthorizedException('Invalid token type');
  }
  return {
    id:          payload[JwtClaims.SUBJECT]     as string,
    username:    payload[JwtClaims.USERNAME]    as string,
    role:        payload[JwtClaims.ROLE]        as string,
    storeId:     payload[JwtClaims.STORE_ID]    as string,
    permissions: payload[JwtClaims.PERMISSIONS] as string[],
    jti:         payload[JwtClaims.JTI]         as string,
  };
}
```

**Usage in `AuthService.signAccessToken()`:**

```ts
// src/auth/auth.service.ts
import { JwtClaims } from './constants/jwt-claims';

private signAccessToken(user: UserRow, permissions: string[]): string {
  return this.jwtService.sign({
    [JwtClaims.SUBJECT]:     user.id,
    [JwtClaims.USERNAME]:    user.username,
    [JwtClaims.ROLE]:        user.role,
    [JwtClaims.STORE_ID]:    user.storeId,
    [JwtClaims.PERMISSIONS]: permissions,
    [JwtClaims.TOKEN_TYPE]:  'access',
  });
}

private signRefreshToken(jti: string): string {
  return this.jwtService.sign(
    { [JwtClaims.TOKEN_TYPE]: 'refresh', [JwtClaims.JTI]: jti },
    { secret: this.config.jwtRefreshSecret, expiresIn: this.config.jwtRefreshExpiry },
  );
}
```

**The `TOKEN_TYPE` claim is a security control, not just documentation.** Without it, an attacker
who obtains a refresh token (longer-lived, stored in an HttpOnly cookie) can use it as a bearer
token to access protected API endpoints — because the signature is valid and Passport doesn't know
it is the wrong token type. The guard in `validate()` above closes this hole.

---

### 3.11 Reference Table Columns (`referenceColumns`)

**Source:** `BaseReferenceEntity.java`

**Problem:** Lookup/master data tables (payment methods, product categories, tax codes, units) need
different lifecycle semantics than transaction tables (products, orders). Transaction tables use
`deletedAt` for soft-delete and `createdBy`/`updatedBy` for audit. Reference tables need:
- `sortOrder` — control display order in dropdowns without re-inserting rows
- `isHidden` — hide an option from UI without deleting it (seasonal, deprecated)
- `isSystem` — prevent deletion of seed data seeded by migrations
- `isActive` — soft-disable an entry without deleting it

**Why `isSystem` is the critical addition:** Without it, a shop owner can delete `CASH` as a
payment method from the admin UI. If they later want it back, they need a DB migration or a
support intervention. With `isSystem = true` on seed data, the service layer rejects the delete
before it reaches the DB.

```ts
// src/db/reference.ts
import { boolean, integer } from 'drizzle-orm/pg-core';

export const referenceColumns = {
  sortOrder: integer('sort_order').notNull().default(0),
  isHidden:  boolean('is_hidden').notNull().default(false),
  isSystem:  boolean('is_system').notNull().default(false),
  isActive:  boolean('is_active').notNull().default(true),
};
```

**Apply to the `lookups` table (not to `products` or `orders` — those use `deletedAt`):**

```ts
// src/db/schema/lookups.schema.ts
import { referenceColumns } from '../reference';
import { auditColumns }     from '../audit';

export const lookups = pgTable('lookups', {
  id:       uuid('id').primaryKey().defaultRandom(),
  storeId:  uuid('store_id').references(() => stores.id),   // null = system-wide
  category: text('category').notNull(),
  code:     text('code').notNull(),
  label:    text('label').notNull(),
  metadata: jsonb('metadata'),
  ...referenceColumns,   // sortOrder, isHidden, isSystem, isActive
  ...auditColumns,       // createdAt, updatedAt, createdBy, updatedBy (no deletedAt on lookups)
}, (t) => [
  uniqueIndex('lookups_store_cat_code_uq').on(t.storeId, t.category, t.code),
]);
```

**Enforce `isSystem` in `LookupsService`:**

```ts
// src/lookups/lookups.service.ts
async softDelete(id: string, storeId: string): Promise<void> {
  const [row] = await this.db.select().from(lookups)
    .where(and(eq(lookups.id, id), eq(lookups.storeId, storeId)));

  if (!row) {
    throw new AppException(ErrorCodes.NOT_FOUND, `Lookup ${id} not found`, 404);
  }
  if (row.isSystem) {
    throw new AppException(
      ErrorCodes.FORBIDDEN,
      'System-managed lookups cannot be deleted — they can only be hidden (isHidden)',
      403,
    );
  }

  await this.db.update(lookups)
    .set({ isActive: false, ...withUpdatedBy(this.cls.get('userId')) })
    .where(eq(lookups.id, id));
}
```

**Seed system lookups with `isSystem: true`:**

```ts
// src/db/seeds/lookups.seed.ts
// All system entries have isSystem: true so the service layer blocks deletion
export const systemLookups = [
  { category: 'payment_method', code: 'CASH', label: 'Cash',               sortOrder: 1, isSystem: true },
  { category: 'payment_method', code: 'CARD', label: 'Credit / Debit Card', sortOrder: 2, isSystem: true },
  { category: 'payment_method', code: 'UPI',  label: 'UPI',                sortOrder: 3, isSystem: true },
  // ... etc
];
```

**Two separate column sets — why:**

| Column set | Applied to | Purpose |
|------------|-----------|---------|
| `auditColumns` | all tables | who created/updated/deleted a row and when |
| `referenceColumns` | lookup/master tables only | visibility + system-protection flags |
| `deletedAt` / `deletedBy` (in auditColumns) | transaction tables | timestamped soft-delete |
| `isActive` (in referenceColumns) | reference tables | soft-disable without a timestamp |

Transaction tables (products, orders, users) use `deletedAt` — you need to know *when* something
was deleted. Reference tables (lookups, roles) use `isActive` — the timestamp matters less than
the flag itself, and the full `auditColumns.updatedAt` already captures when `isActive` changed.

---

### 3.12 `ResponseMessages` Constant Object

**Source:** `ApiResponseConstants.java`

**Problem:** Without a central file, response message strings scatter across 30 controller methods
as inline string literals in `@ResponseMessage(...)` decorators. Ayphen has
`MSG_PRODUCT_CREATED_SUCCESSFULLY`, `MSG_ORDER_PAID_SUCCESSFULLY`, etc. as `public static final
String` constants — the correct instinct, executed with poor ergonomics (300 loose constants in
one flat class). The NestJS equivalent is a typed nested constant object.

**Why it matters:** Typo drift. After 10 controllers, you will find
`'Product created successfully'`, `'Product Created successfully'`, and
`'Product created Successfully'` in the same codebase. The mobile team parses these strings in
their UI. Inconsistency breaks string-matching in their code.

```ts
// src/common/response-messages.ts
export const ResponseMessages = {
  auth: {
    login:     'Login successful',
    logout:    'Logged out successfully',
    refresh:   'Token refreshed',
    register:  'Account created successfully',
  },
  products: {
    created:   'Product created successfully',
    updated:   'Product updated successfully',
    deleted:   'Product deleted successfully',
    found:     'Product retrieved successfully',
    list:      'Products retrieved successfully',
  },
  orders: {
    created:   'Order created successfully',
    paid:      'Order payment recorded',
    cancelled: 'Order cancelled',
    refunded:  'Order refunded',
    found:     'Order retrieved successfully',
    list:      'Orders retrieved successfully',
  },
  lookups: {
    created:   'Lookup created successfully',
    updated:   'Lookup updated successfully',
    deleted:   'Lookup deleted successfully',
    list:      'Lookups retrieved successfully',
  },
  users: {
    created:   'User created successfully',
    updated:   'User updated successfully',
    deleted:   'User deleted successfully',
    found:     'User retrieved successfully',
    list:      'Users retrieved successfully',
  },
} as const;
```

**Usage in controllers:**

```ts
// src/products/products.controller.ts
import { ResponseMessages } from '../common/response-messages';

@Post()
@ResponseMessage(ResponseMessages.products.created)   // ← typed reference, not a string literal
async create(@Body() dto: CreateProductDto): Promise<ProductDto> {
  return this.service.create(dto);
}

@Delete(':id')
@ResponseMessage(ResponseMessages.products.deleted)
async remove(@Param('id') id: string): Promise<void> {
  await this.service.softDelete(id);
}
```

**Add a new domain:** When you add an `OrdersController`, add `orders: { ... }` to the object.
TypeScript auto-completes the keys. If you mistype `ResponseMessages.orders.creted`, the compiler
catches it at build time — impossible with inline string literals.

---

### 3.13 Conditional DTO Validation (`@ValidateIf`)

**Source:** `ConditionalRequestValidator.java`

**Problem:** Some DTO fields are only required when another field has a specific value. Ayphen uses
a class-level `@Constraint` that inspects multiple fields and conditionally applies validation
rules. In NestJS, the idiomatic equivalent is `@ValidateIf` per field — cleaner and easier to
read.

**Concrete POS scenario:** A `CreateProductDto` has a `productType` field.
- `STANDARD` products need `price` and `stock`
- `WEIGHED` products need `pricePerKg` and `weightUnit`; `stock` is irrelevant (sold by weight)
- `SERVICE` products need `price` but no `stock`
- `BUNDLE` products have their `price` computed from components; neither `price` nor `stock` are
  entered manually

Without `@ValidateIf`, you have two bad options: make every field optional (no safety) or make
every field required (breaks the other product types). `@ValidateIf` gives you the third option:
conditionally required.

```ts
// src/products/dto/create-product.dto.ts
import {
  IsEnum, IsNotEmpty, IsNumber, IsInt, IsOptional, IsString,
  Min, ValidateIf,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export enum ProductType {
  STANDARD = 'STANDARD',   // fixed price, finite stock
  WEIGHED  = 'WEIGHED',    // price per KG, unlimited virtual stock
  SERVICE  = 'SERVICE',    // no physical stock, fixed price
  BUNDLE   = 'BUNDLE',     // price derived from component products
}

export class CreateProductDto {
  @ApiProperty({ enum: ProductType })
  @IsEnum(ProductType)
  productType: ProductType;

  @ApiProperty({ example: 'Coca-Cola 330ml' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({ example: 'COKE-330' })
  @IsString()
  @IsNotEmpty()
  sku: string;

  // Required only when the price is fixed (STANDARD or SERVICE).
  // WEIGHED uses pricePerKg instead; BUNDLE derives price from components.
  @ApiPropertyOptional({ example: 1.99 })
  @ValidateIf(o => o.productType === ProductType.STANDARD || o.productType === ProductType.SERVICE)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  price?: number;

  // Required only for WEIGHED products — the per-KG rate.
  @ApiPropertyOptional({ example: 3.50, description: 'Price per kilogram (WEIGHED only)' })
  @ValidateIf(o => o.productType === ProductType.WEIGHED)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  pricePerKg?: number;

  // Required only for STANDARD products — stock does not apply to services or bundles.
  @ApiPropertyOptional({ example: 50, default: 0 })
  @ValidateIf(o => o.productType === ProductType.STANDARD)
  @IsInt()
  @Min(0)
  stock?: number;

  // Required for WEIGHED products to display correct unit label on receipts.
  @ApiPropertyOptional({ example: 'KG' })
  @ValidateIf(o => o.productType === ProductType.WEIGHED)
  @IsString()
  @IsNotEmpty()
  weightUnit?: string;

  // Optional for all product types — pulled from the lookups table on save.
  @ApiPropertyOptional({ example: 'BEVERAGES' })
  @IsOptional()
  @IsString()
  categoryCode?: string;
}
```

**How the service enforces the constraint at the DB layer too:**

```ts
// src/products/products.service.ts
async create(dto: CreateProductDto, userId: string): Promise<ProductDto> {
  // LookupsService validates that categoryCode is an active member of 'product_category'.
  if (dto.categoryCode) {
    await this.lookupsService.validateCode('product_category', dto.categoryCode, storeId);
  }

  const price = dto.productType === ProductType.WEIGHED ? dto.pricePerKg : dto.price;
  // price is guaranteed defined here because @ValidateIf enforced it at the DTO layer.
  // ...
}
```

**Why `@ValidateIf` and not a custom class-level validator:** A class-level validator (like
Ayphen's `ConditionalRequestValidator`) fires once and checks all fields together. `@ValidateIf`
fires per-field and is composable with any other `class-validator` decorator (`@Min`, `@Max`,
`@IsEmail`, etc.). The per-field approach is more readable and produces cleaner error messages:
`price is required for STANDARD products` rather than a single class-level validation message.

---

## 4. Tier 3 — Take When the Feature Is Needed

---

### 4.1 Activity Log (with diff, IP, requestId)

**Why:** Without `oldValue`/`newValue`, you know something changed but not what. Without `ip` and
`requestId`, you cannot trace a suspicious mutation to its source request.

```ts
// src/db/schema.ts
export const activityLogs = pgTable('activity_logs', {
  id:            uuid('id').primaryKey().defaultRandom(),
  entityType:    text('entity_type').notNull(),       // 'product' | 'order' | 'user'
  entityId:      uuid('entity_id').notNull(),
  action:        text('action').notNull(),             // 'created' | 'updated' | 'deleted' | 'voided'
  oldValue:      jsonb('old_value'),                   // snapshot before mutation
  newValue:      jsonb('new_value'),                   // snapshot after mutation
  message:       text('message'),
  performedBy:   uuid('performed_by').references(() => users.id),
  ipAddress:     text('ip_address'),
  userAgent:     text('user_agent'),
  requestId:     text('request_id'),
  correlationId: text('correlation_id'),               // for cross-service traces if needed later
  createdAt:     timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
```

```ts
// src/activity-log/activity-log.service.ts
@Injectable()
export class ActivityLogService {
  async log(params: {
    entityType:    string;
    entityId:      string;
    action:        string;
    userId:        string;
    message?:      string;
    oldValue?:     Record<string, unknown>;
    newValue?:     Record<string, unknown>;
    ipAddress?:    string;
    userAgent?:    string;
    requestId?:    string;
  }): Promise<void> {
    await this.db.insert(activityLogs).values({
      entityType:  params.entityType,
      entityId:    params.entityId,
      action:      params.action,
      message:     params.message,
      oldValue:    params.oldValue,
      newValue:    params.newValue,
      performedBy: params.userId,
      ipAddress:   params.ipAddress,
      userAgent:   params.userAgent,
      requestId:   params.requestId,
    });
  }
}
```

**Usage after a mutation:**

```ts
await this.activityLog.log({
  entityType: 'product',
  entityId:   product.id,
  action:     'price_updated',
  userId:     user.id,
  message:    `Price changed from ${oldPrice} to ${newPrice}`,
  oldValue:   { price: oldPrice },
  newValue:   { price: newPrice },
  requestId:  request.headers['x-request-id'] as string,
  ipAddress:  request.ip,
  userAgent:  request.headers['user-agent'],
});
```

---

### 4.2 Order State Machine + Optimistic Locking

**State machine** prevents double-charge, double-cancel, and re-opening of paid orders.

```
PENDING ──→ PAID
PENDING ──→ CANCELLED
PAID    ──→ REFUNDED
```

```ts
// src/orders/order-transitions.ts
type OrderStatus = 'pending' | 'paid' | 'cancelled' | 'refunded';

const VALID_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  pending:   ['paid', 'cancelled'],
  paid:      ['refunded'],
  cancelled: [],
  refunded:  [],
};

export function assertValidTransition(from: OrderStatus, to: OrderStatus): void {
  if (!VALID_TRANSITIONS[from].includes(to)) {
    throw new AppException(
      ErrorCodes.INVALID_ORDER_TRANSITION,
      `Cannot transition order from '${from}' to '${to}'`,
      422,
    );
  }
}
```

**Optimistic locking** on the `version` column (added in schema, section 2.9) prevents two
concurrent requests from overwriting each other's status change:

```ts
async payOrder(orderId: string, userId: string): Promise<OrderDto> {
  const [order] = await this.db.select().from(orders)
    .where(and(eq(orders.id, orderId), isNull(orders.deletedAt)));

  if (!order) throw new AppException(ErrorCodes.ORDER_NOT_FOUND, `Order ${orderId} not found`, 404);
  assertValidTransition(order.status as OrderStatus, 'paid');

  // Update only if version still matches — detects concurrent modification
  const [updated] = await this.db.update(orders)
    .set({ status: 'paid', version: sql`${orders.version} + 1`, ...withUpdatedBy(userId) })
    .where(and(
      eq(orders.id, orderId),
      eq(orders.version, order.version),    // optimistic lock check
    ))
    .returning();

  if (!updated) {
    throw new AppException(
      ErrorCodes.CONCURRENT_MODIFICATION,
      'Order was modified by another request — please retry',
      409,
    );
  }

  return this.mapper.toDto(updated);
}
```

---

### 4.3 Domain Events

**Problem:** Wiring `OrderService → ActivityLogService + EmailService + WebSocketGateway` directly
creates tight coupling. Adding an analytics listener later means modifying `OrderService`. Domain
events invert this: `OrderService` emits once; each listener is independent.

```bash
pnpm add @nestjs/event-emitter --filter @ayphen/backend
```

```ts
// src/common/events/order.events.ts
export class OrderPaidEvent {
  constructor(
    public readonly orderId:   string,
    public readonly userId:    string,
    public readonly storeId:   string,
    public readonly total:     string,
    public readonly requestId: string,
  ) {}
}

export class OrderCancelledEvent {
  constructor(
    public readonly orderId:   string,
    public readonly userId:    string,
    public readonly requestId: string,
  ) {}
}
```

```ts
// src/orders/orders.service.ts — emit after successful DB write
async payOrder(orderId: string, userId: string, requestId: string): Promise<OrderDto> {
  // ... state machine + optimistic-locked DB update (see §4.2); `updated` is the returned row.
  // storeId comes from the order row (it is NOT derivable from userId alone).
  this.eventEmitter.emit(
    'order.paid',
    new OrderPaidEvent(updated.id, userId, updated.storeId, updated.total, requestId),
  );
  return this.mapper.toDto(updated);
}
```

> Note: this requires `orders` to carry `storeId` (add it the same way `products` does in §2.9),
> so `updated.storeId` is available for the store-scoped WebSocket room in §4.7.

```ts
// src/activity-log/activity-log.listener.ts
@Injectable()
export class ActivityLogListener {
  @OnEvent('order.paid')
  async onOrderPaid(event: OrderPaidEvent): Promise<void> {
    await this.activityLog.log({
      entityType: 'order',
      entityId:   event.orderId,
      action:     'paid',
      userId:     event.userId,
      requestId:  event.requestId,
    });
  }
}

// src/email/email.listener.ts
@Injectable()
export class EmailListener {
  @OnEvent('order.paid')
  async onOrderPaid(event: OrderPaidEvent): Promise<void> {
    await this.emailQueue.add('send-receipt', event);   // see section 4.6
  }
}

// src/gateways/pos.gateway.listener.ts
@Injectable()
export class PosGatewayListener {
  @OnEvent('order.paid')
  onOrderPaid(event: OrderPaidEvent): void {
    this.posGateway.emitOrderPaid(event);               // see section 4.7
  }
}
```

Each listener is registered as a provider in its own module. Adding analytics later means adding
one new listener file — `OrdersService` does not change.

---

### 4.4 Idempotency

**Problem:** A mobile app on a flaky 4G connection may retry a payment POST after a timeout.
Without idempotency, the POS charges the customer twice.

**Pattern:** Client sends an `Idempotency-Key` header (UUID they generate). The server atomically
**reserves** the key before doing any work, caches the first response in Redis for 24 h, and serves
that cached response to any later request with the same key.

> **Why a plain get-then-set is not enough:** a naive `get` → miss → `fn()` → `set` has a race.
> Two concurrent retries (exactly the flaky-network case this guards against) both miss the cache
> and both execute `fn()` → double charge. The fix is an atomic reservation with `SET key … NX`:
> only one request wins the reservation; the others wait for and return the stored result.

```ts
// src/common/idempotency/idempotency.service.ts
@Injectable()
export class IdempotencyService {
  constructor(@Inject('REDIS_CLIENT') private readonly redis: Redis) {}

  async wrap<T>(key: string, ttlSeconds: number, fn: () => Promise<T>): Promise<T> {
    // 1. Already completed? Return the stored result.
    const existing = await this.redis.get(key);
    if (existing) return this.unwrap<T>(existing);

    // 2. Atomically reserve the key. SET NX returns null if another request already holds it.
    const reserved = await this.redis.set(key, '__pending__', 'EX', ttlSeconds, 'NX');
    if (reserved === null) {
      // Another request is in flight (or just finished) — wait briefly and read its result.
      return this.awaitResult<T>(key);
    }

    // 3. We own the key. Execute once, then store the real result under the same key.
    try {
      const result = await fn();
      await this.redis.set(key, JSON.stringify({ status: 'done', value: result }), 'EX', ttlSeconds);
      return result;
    } catch (err) {
      // Release the reservation so a legitimate retry can proceed (don't cache failures).
      await this.redis.del(key);
      throw err;
    }
  }

  private unwrap<T>(raw: string): T {
    const parsed = JSON.parse(raw);
    if (parsed?.status === 'done') return parsed.value as T;
    // raw is the '__pending__' marker — caller should await instead
    throw new AppException(
      ErrorCodes.DUPLICATE_IDEMPOTENCY_KEY,
      'Request with this Idempotency-Key is still being processed',
      409,
    );
  }

  private async awaitResult<T>(key: string, retries = 20, delayMs = 150): Promise<T> {
    for (let i = 0; i < retries; i++) {
      const raw = await this.redis.get(key);
      if (raw && raw !== '__pending__') return this.unwrap<T>(raw);
      await new Promise((r) => setTimeout(r, delayMs));
    }
    throw new AppException(
      ErrorCodes.DUPLICATE_IDEMPOTENCY_KEY,
      'Request with this Idempotency-Key is still being processed',
      409,
    );
  }
}
```

```ts
// src/orders/orders.controller.ts
@Post(':id/pay')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission(Permissions.ORDERS_CREATE)
@ResponseMessage('Order paid')
async payOrder(
  @Param('id') id: string,
  @CurrentUser() user: RequestUser,
  @Headers('idempotency-key') idempotencyKey: string,
  @Req() req: Request,
): Promise<OrderDto> {
  if (!idempotencyKey) {
    throw new AppException(ErrorCodes.MISSING_IDEMPOTENCY_KEY, 'Idempotency-Key header is required', 400);
  }
  const cacheKey = `pay-order:${user.storeId}:${idempotencyKey}`;
  return this.idempotency.wrap(cacheKey, 86_400, () =>
    this.service.payOrder(id, user.id, req.headers['x-request-id'] as string),
  );
}
```

---

### 4.5 Scheduled Tasks

```bash
pnpm add @nestjs/schedule --filter @ayphen/backend
```

```ts
// src/scheduler/low-stock.scheduler.ts
@Injectable()
export class LowStockScheduler {
  @Cron('0 8 * * *')    // every day at 08:00
  async checkLowStock(): Promise<void> {
    const lowStock = await this.productsService.findLowStock(5);
    if (lowStock.length) {
      await this.emailQueue.add('low-stock-alert', { products: lowStock });
    }
  }
}

// src/scheduler/pending-order-cleanup.scheduler.ts
@Injectable()
export class PendingOrderCleanupScheduler {
  @Cron('*/30 * * * *')   // every 30 minutes
  async cancelAbandonedOrders(): Promise<void> {
    const cutoff = new Date(Date.now() - 30 * 60 * 1000);
    await this.db.update(orders)
      .set({ status: 'cancelled', ...withUpdatedBy('system') })
      .where(and(
        eq(orders.status, 'pending'),
        lt(orders.createdAt, cutoff),
        isNull(orders.deletedAt),
      ));
  }
}
```

---

### 4.6 Email via Queue (BullMQ)

**Why queue, not direct send:** `mailerService.sendMail()` blocks the HTTP response thread. If the
SMTP server is slow or unavailable, the HTTP request hangs. A queue decouples the response from
the send and provides automatic retries on failure.

```bash
pnpm add @nestjs/bullmq bullmq @nestjs-modules/mailer handlebars --filter @ayphen/backend
```

```
src/email/
├── email.module.ts
├── email.processor.ts      ← BullMQ worker
└── templates/
    ├── receipt.hbs
    ├── low-stock-alert.hbs
    ├── daily-summary.hbs
    └── refund-confirmation.hbs
```

```ts
// src/email/email.processor.ts
// NOTE: @nestjs/bullmq does NOT have a per-job @Process('name') decorator (that was the
// legacy @nestjs/bull API). A BullMQ processor extends WorkerHost and implements a single
// process(job) method that branches on job.name. (Alternatively, use one queue per job type.)
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';

@Processor('email')
export class EmailProcessor extends WorkerHost {
  async process(job: Job): Promise<void> {
    switch (job.name) {
      case 'send-receipt':
        return this.sendReceipt(job as Job<OrderPaidEvent>);
      case 'low-stock-alert':
        return this.sendLowStockAlert(job as Job<{ products: ProductDto[] }>);
      default:
        throw new Error(`Unhandled email job: ${job.name}`);
    }
  }

  private async sendReceipt(job: Job<OrderPaidEvent>): Promise<void> {
    const order = await this.ordersService.findById(job.data.orderId);
    await this.mailerService.sendMail({
      to:       order.customerEmail,
      subject:  `Receipt for Order #${order.id}`,
      template: 'receipt',
      context:  { order },
    });
  }

  private async sendLowStockAlert(job: Job<{ products: ProductDto[] }>): Promise<void> {
    await this.mailerService.sendMail({
      to:       this.config.managerEmail,
      subject:  'Low Stock Alert',
      template: 'low-stock-alert',
      context:  { products: job.data.products },
    });
  }
}
```

Enqueue from any service or listener:

```ts
await this.emailQueue.add('send-receipt', event, { attempts: 3, backoff: { type: 'exponential', delay: 5000 } });
```

---

### 4.7 WebSocket with Store Rooms

**Problem:** `server.emit()` broadcasts to every connected terminal in the entire deployment. In a
multi-store setup this means cashier terminals in Store A receive Order events from Store B.
Terminals must join a store-scoped room on connect.

```bash
pnpm add @nestjs/websockets @nestjs/platform-socket.io socket.io --filter @ayphen/backend
```

```ts
// src/gateways/pos.gateway.ts
@WebSocketGateway({ cors: true })
export class PosGateway {
  @WebSocketServer() server: Server;

  @SubscribeMessage('join-store')
  handleJoinStore(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { storeId: string },
  ): void {
    client.join(`store:${data.storeId}`);
  }

  emitOrderPaid(event: OrderPaidEvent): void {
    // Only terminals for that specific store receive this event
    this.server.to(`store:${event.storeId}`).emit('order:paid', {
      orderId: event.orderId,
      total:   event.total,
    });
  }

  emitStockUpdated(storeId: string, product: ProductDto): void {
    this.server.to(`store:${storeId}`).emit('product:stock-updated', product);
  }
}
```

Client joins the room after connecting:

```ts
// Mobile / web client
socket.emit('join-store', { storeId: currentStoreId });
```

---

### 4.8 Redis Caching

**What to cache:** Read-heavy, write-infrequent data that does not need to be real-time accurate to
the millisecond.

| Cache Key Pattern | TTL | Contents |
|-------------------|-----|----------|
| `catalog:{storeId}:page:{n}` | 60 s | Paginated product list |
| `permissions:{userId}` | 900 s | Permission snapshot (supplement JWT) |
| `settings:{storeId}` | 300 s | Store configuration |

```bash
pnpm add ioredis cache-manager cache-manager-ioredis-yet --filter @ayphen/backend
```

```ts
// src/cache/cache.module.ts
@Global()
@Module({
  imports: [
    CacheModule.registerAsync({
      isGlobal: true,
      useFactory: (config: AppConfigService) => ({
        store: redisStore,
        url:   config.redisUrl,
        ttl:   60_000,   // 60 s default
      }),
      inject: [AppConfigService],
    }),
  ],
})
export class AppCacheModule {}
```

```ts
// In products.service.ts — cache catalog pages, namespaced by a per-store version counter.
// cache-manager's del() deletes a SINGLE literal key — it does NOT expand `*` globs, so you
// cannot wildcard-delete catalog pages. Instead, fold a version number into every cache key
// and bump that version on any write: old keys are instantly orphaned and expire on their TTL.

private async catalogVersion(storeId: string): Promise<number> {
  return (await this.cache.get<number>(`catalog-ver:${storeId}`)) ?? 1;
}

async findAll(req: PaginationRequest, storeId: string): Promise<PaginationResponse<ProductDto>> {
  const ver      = await this.catalogVersion(storeId);
  const cacheKey = `catalog:${storeId}:v${ver}:p${req.pageNo}:s${req.pageSize}:by${req.sortBy ?? 'createdAt'}:${req.sortDir}`;
  const cached   = await this.cache.get<PaginationResponse<ProductDto>>(cacheKey);
  if (cached) return cached;

  const result = await this.queryProducts(req);
  await this.cache.set(cacheKey, result, 60_000);
  return result;
}

// Invalidate on write — bump the version so every catalog:<store>:v<old> key is orphaned at once.
async create(dto: CreateProductDto, userId: string): Promise<ProductDto> {
  const product = await this.insertProduct(dto, userId);
  const ver = await this.catalogVersion(product.storeId);
  await this.cache.set(`catalog-ver:${product.storeId}`, ver + 1);  // no glob delete needed
  return product;
}
```

> If you genuinely need to evict matching keys (not just orphan them), use the raw ioredis client
> with `SCAN` + `del` — never `KEYS` in production, and never a `*` in `cache.del()`, which is a
> silent no-op.

---

## 5. What NOT to Take

| Ayphen Pattern | Reason to Skip for POS |
|----------------|------------------------|
| Multi-tenancy — `/companies/{tenantId}/` path prefix | POS is single-tenant. The extra path segment adds complexity with zero benefit. |
| `ApplicationEntity` per-tenant feature flags | No tenants, no flags needed at this scale. |
| `CountryAppEntityMap` country-level localisation | Single-country retail store. |
| Plaid bank linking | Open banking is not relevant to a point-of-sale system. |
| Microsoft Graph / OneDrive integration | Not needed for POS. |
| Keycloak / IAM (`iamUserId` field on users) | JWT-only auth is sufficient. Keycloak is enterprise SSO overhead. |
| 49 transaction type handlers (Strategy pattern) | POS has 3 types: sale, refund, void. A `switch` is correct; a 49-handler strategy is over-engineering. |
| `IProductsService` interface per service | NestJS services are already injectable. Interfaces only make sense when you have multiple implementations (e.g. `StripePaymentService` vs `CashPaymentService`). |
| Property Management System sub-module | Unrelated domain. |
| Resilience4j circuit breaker | Only needed for unreliable external APIs. Add if/when a payment gateway integration requires it. |
| Separate `application-rm.yml`, `application-km.yml` profiles | Client-specific config. You have one client (the shop). |
| 12-method `EmailServiceImpl` on day 1 | Build only the email templates you actually send. |

---

## 6. Implementation Roadmap

### Week 1 — Foundation

- [ ] `src/config/env.ts` — Zod env schema + `AppConfigService`; add `CORS_ORIGINS` field
- [ ] `src/logger/logger.module.ts` — Pino structured logger
- [ ] `src/common/middleware/request-id.middleware.ts` — generate + propagate `x-request-id`
- [ ] `src/common/error-codes.ts` — typed error code constants; add `RATE_LIMIT_EXCEEDED`
- [ ] `src/common/exceptions/app.exception.ts` — `AppException`
- [ ] `src/common/interceptors/response.interceptor.ts` — global response interceptor
- [ ] `src/common/decorators/response-message.decorator.ts` — `@ResponseMessage`
- [ ] `src/common/filters/http-exception.filter.ts` — complete exception filter (add `ThrottlerException` branch; set `UNAUTHORIZED`/`FORBIDDEN` error codes for 401/403 `HttpException`)
- [x] `src/common/pagination/` — cursor: `cursor.ts`, `paginate.ts`, `paginated-response.ts` (✅ done); offset `PaginationRequest`/`PaginationResponse` (§2.8.1) still to add when a page-numbered admin table needs it
- [ ] `app.enableCors({ origin, credentials: true, ... })` in `main.ts` before global filters
- [ ] `app.setGlobalPrefix('api', { exclude: [health, docs] })` in `main.ts`
- [ ] Register `TrimStringPipe` + `ValidationPipe` globally in `main.ts` — trim pipe first
- [ ] Register interceptor + filter globally in `main.ts`
- [ ] `src/common/pipes/trim-string.pipe.ts` — `TrimStringPipe` (§2.14)
- [ ] `src/common/response-messages.ts` — `ResponseMessages` constant object (§3.12)
- [ ] `pnpm add @nestjs/swagger`; setup `DocumentBuilder` + `SwaggerModule.setup('docs', ...)` in `main.ts` (§2.15)
- [ ] `src/db/audit.ts` — `auditColumns` + `withAudit` / `withSoftDelete` helpers
- [ ] `src/db/reference.ts` — `referenceColumns` (§3.11)
- [ ] Migrate all table definitions to `...auditColumns` (replacing old `isActive` boolean)
- [ ] Run `pnpm db:push` to apply schema changes
- [ ] Update all existing queries: `isNull(table.deletedAt)` instead of `eq(table.isActive, true)`
- [ ] Remove all manual `ApiResponse.ok()` calls from controllers — they now return plain DTOs
- [ ] `pnpm add @nestjs/terminus --filter @ayphen/backend`; build `src/health/` module with Drizzle ping, memory, disk indicators
- [ ] Add `HEALTHCHECK` directive to `Dockerfile`
- [ ] `pnpm add @nestjs/throttler --filter @ayphen/backend`; register `ThrottlerModule` + `APP_GUARD` in `AppModule`; apply `@SkipThrottle()` to `HealthController`

### Week 2 — Auth & Security

- [ ] `pnpm add @nestjs/cls`; register `ClsModule.forRoot` in `AppModule` (§3.9)
- [ ] `src/auth/constants/jwt-claims.ts` — `JwtClaims` constant object (§3.10)
- [ ] Add `users`, `roles`, `rolePermissions`, `refreshTokens` tables to Drizzle schema
- [ ] Build `AuthModule` with `AuthService`, `JwtStrategy`, `JwtAuthGuard`
- [ ] `JwtAuthGuard.handleRequest` — push `userId` and `storeId` into CLS after token validation
- [ ] Login: hash refresh token, insert to DB, set HttpOnly cookie, bake permissions into JWT using `JwtClaims` constants
- [ ] `JwtStrategy.validate` — use `JwtClaims` constants; reject tokens where `type !== 'access'`
- [ ] Refresh endpoint: lookup by `SHA-256(token)`, rotate (revoke old, issue new)
- [ ] Logout: revoke by `jti`, clear cookie
- [ ] `src/auth/decorators/current-user.decorator.ts` — `CurrentUser` + `CurrentStoreId`
- [ ] `src/common/permissions.ts` — `Permissions` constants
- [ ] `PermissionsGuard` reading permissions from `user.permissions` (JWT snapshot)
- [ ] `RequirePermission` decorator
- [ ] Apply guards + `@RequirePermission` to all existing endpoints

### Week 3 — Mappers, Transactions & Structural Modules

- [ ] `src/products/products.mapper.ts` — translation only, no formatting
- [ ] `src/orders/orders.mapper.ts`
- [ ] Wrap all multi-table mutations in `db.transaction()`
- [ ] Add whitelist sort column maps to all list services
- [ ] `src/activity-log/` module — schema + service (wire into mutations)
- [ ] `src/common/events/` — domain event classes
- [ ] Wire `EventEmitter` into `OrdersService`; add `ActivityLogListener`, `EmailListener`
- [ ] `src/db/schema/sequences.schema.ts` + `src/common/services/sequence.service.ts` — order number generation with `SELECT FOR UPDATE`
- [ ] Add `orderNumber text UNIQUE NOT NULL` to `orders` schema; seed `sequences` table
- [ ] `src/db/schema/lookups.schema.ts` — lookup table + unique index
- [ ] Seed system-wide lookups (payment methods, product categories, units, tax codes)
- [ ] `src/lookups/` module — `LookupsService.findByCategory()` + `validateCode()`; apply Redis caching

### Week 4 — Business Logic Correctness

- [ ] `src/orders/order-transitions.ts` — `assertValidTransition()`
- [ ] Add `version` column to `orders` table; apply optimistic lock in `payOrder`, `cancelOrder`, `refundOrder`
- [ ] `src/common/idempotency/` — `IdempotencyService` backed by Redis
- [ ] Apply idempotency check to all payment and refund endpoints
- [ ] `OrdersService.create()` — call `sequenceService.nextOrderNumber('order')` and `lookupsService.validateCode('payment_method', ...)`

### Later — When Features Demand It

- [ ] `@nestjs/schedule` — low-stock alert, abandoned order cleanup, daily summary
- [ ] BullMQ email queue — receipt, low-stock alert, refund confirmation
- [ ] WebSocket gateway with store rooms — multi-terminal real-time events
- [ ] Redis caching — catalog pages, permission snapshots, store settings

---

## 7. File Structure Target

```
apps/backend/src/
├── main.ts
├── app/
│   ├── app.module.ts
│   ├── app.controller.ts
│   └── app.service.ts
├── config/
│   ├── config.module.ts
│   ├── app-config.service.ts
│   └── env.ts                              ← Zod schema + parsed env singleton
├── logger/
│   └── logger.module.ts                    ← Pino global logger
├── auth/
│   ├── auth.module.ts
│   ├── auth.controller.ts
│   ├── auth.service.ts
│   ├── constants/
│   │   └── jwt-claims.ts                   ← §3.10 JWT claim name constants
│   ├── strategies/
│   │   └── jwt.strategy.ts
│   ├── guards/
│   │   ├── jwt-auth.guard.ts               ← extends AuthGuard('jwt'); pushes userId/storeId into CLS
│   │   └── permissions.guard.ts
│   ├── decorators/
│   │   ├── current-user.decorator.ts       ← CurrentUser + CurrentStoreId
│   │   └── require-permission.decorator.ts
│   └── interfaces/
│       ├── jwt-payload.interface.ts
│       └── request-user.interface.ts
├── common/
│   ├── error-codes.ts
│   ├── permissions.ts
│   ├── pagination/                         ← cursor.ts, paginate.ts, paginated-response.ts (§2.8.2 ✅)
│   ├── response-messages.ts                ← §3.12 ResponseMessages constant object
│   ├── db-context.ts                       ← withAudit / withSoftDelete helpers
│   ├── decorators/
│   │   └── response-message.decorator.ts
│   ├── events/
│   │   └── order.events.ts
│   ├── exceptions/
│   │   └── app.exception.ts
│   ├── filters/
│   │   └── http-exception.filter.ts        ← handles all 5 error categories + ThrottlerException
│   ├── guards/                             ← shared guards
│   ├── idempotency/
│   │   └── idempotency.service.ts
│   ├── interceptors/
│   │   ├── response.interceptor.ts         ← global envelope
│   │   └── logging.interceptor.ts          ← optional per-route timing log
│   ├── middleware/
│   │   └── request-id.middleware.ts
│   ├── pipes/
│   │   └── trim-string.pipe.ts             ← §2.14 global string trim + empty→null
│   ├── services/
│   │   └── sequence.service.ts             ← §3.7 human-readable order numbers
│   ├── types/                              ← shared TypeScript types
│   └── utils/                             ← pure utility functions
├── db/
│   ├── audit.ts                            ← auditColumns + withAudit/withSoftDelete helpers
│   ├── reference.ts                        ← §3.11 referenceColumns (sortOrder, isHidden, isSystem, isActive)
│   ├── db.module.ts
│   └── schema/
│       ├── audit.schema.ts
│       ├── stores.schema.ts
│       ├── users.schema.ts
│       ├── products.schema.ts
│       ├── orders.schema.ts
│       ├── sequences.schema.ts             ← §3.7 order number sequences
│       ├── lookups.schema.ts               ← §3.8 master data / dropdown table
│       └── index.ts                        ← re-exports all tables
├── health/
│   ├── health.module.ts                    ← §2.12 health check endpoint
│   ├── health.controller.ts               ← GET /health (excluded from /api prefix)
│   └── drizzle-health.indicator.ts        ← custom Drizzle SELECT 1 ping
├── throttle/
│   └── throttle.module.ts                 ← §2.13 ThrottlerModule with 'global' + 'auth' configs
├── cache/
│   └── cache.module.ts                     ← Redis CacheModule global
├── products/
│   ├── products.module.ts
│   ├── products.controller.ts
│   ├── products.service.ts
│   ├── products.mapper.ts
│   └── dto/
│       ├── product.dto.ts
│       ├── create-product.dto.ts
│       └── update-product.dto.ts
├── orders/
│   ├── orders.module.ts
│   ├── orders.controller.ts
│   ├── orders.service.ts
│   ├── orders.mapper.ts
│   ├── order-transitions.ts
│   └── dto/
│       ├── order.dto.ts
│       ├── create-order.dto.ts
│       └── update-order.dto.ts
├── lookups/
│   ├── lookups.module.ts                   ← §3.8 master data / lookup table module
│   ├── lookups.controller.ts
│   ├── lookups.service.ts
│   ├── lookups.mapper.ts
│   └── dto/
│       ├── lookup.dto.ts
│       └── create-lookup.dto.ts
├── activity-log/
│   ├── activity-log.module.ts
│   ├── activity-log.service.ts
│   └── activity-log.listener.ts            ← listens to domain events
├── email/
│   ├── email.module.ts
│   ├── email.processor.ts                  ← BullMQ worker
│   ├── email.listener.ts                   ← subscribes to order events
│   └── templates/
│       ├── receipt.hbs
│       ├── low-stock-alert.hbs
│       ├── daily-summary.hbs
│       └── refund-confirmation.hbs
├── gateways/
│   ├── pos.gateway.ts                      ← WebSocket with store rooms
│   └── pos.gateway.listener.ts
└── scheduler/
    ├── low-stock.scheduler.ts
    └── pending-order-cleanup.scheduler.ts
```

---

*This document is derived from a full architecture analysis of Ayphen 3.0 (`/Users/saran/Downloads/ayphen-3.0/src`) and targeted at the NestJS Retail POS backend at `/apps/backend`. — 2026-06-30 (revised — added §2.14 TrimStringPipe, §2.15 Swagger, §3.9 CLS, §3.10 JWT Claims, §3.11 referenceColumns, §3.12 ResponseMessages, §3.13 @ValidateIf from Ayphen 3.0 comprehensive analysis)*

---

## 8. Domain-Design Adoption — Company / Location / Subscription / Payment

> Added 2026-07-01 from a source-level deep dive of the Java domain (`domain/Company.java`,
> `domain/CompanyLocation.java`, `domain/UserLocationMapping.java`,
> `service/implementation/LocationServiceImpl.java`, `domain/subscription/*`,
> `domain/stripe/RecurringPlan.java`, `StripeServiceImpl`, `StripeRecurringPlanScheduler`).
> Earlier tiers (§2–§4) cover *infrastructure*; this section covers the **business domain**:
> company→location tenancy, subscription/plan shape, and Stripe billing. Verdicts are filtered
> by our reality: **offline-first, single-account, device-bound, limit-driven, Razorpay** POS.

### 8.0 The filter — why not everything transfers

| | Ayphen 3.0 (Java) | Retail POS (us) |
|---|---|---|
| Shape | Multi-tenant, **multi-application** ERP, online-first, web | Offline-first **single-account** mobile POS |
| Billing | **Stripe Connect**, app-driven recurring via daily cron (no provider Subscription object) | **Razorpay** behind a generic `PaymentProvider` port; provider-native subscription |
| Entitlements | **Boolean features only** (`PlanFeatureMap` → `Feature`) | **Numeric** `plan_entitlements` (max_stores/devices/users/products) + boolean `plan_features` |
| Location cap | **None** (locations not plan-gated) | **Plan-gated** `max_locations_per_store` (revenue lever — keep) |
| IDs | `Long id` + public `guuid` UUID (dual) | UUID PKs (simpler, offline-friendly) |

The Java app optimizes for **breadth + back-office correctness**; we optimize for **"never lose a
sale" + local enforcement**. That difference is the adopt/reject filter below.

### 8.1 ADOPT — `user_location_mapping`: role is store-wide, location is a separate access dimension

The single most valuable domain design to steal, because it's the exact location layer we're
building (see `rbac.md §26.3`) and the Java app has it in production.

- **Their model:** `CompanyUser` holds **company-wide roles**; `UserLocationMapping(user, location,
  isActive)` separately controls *where* a user may act. One Cashier role, assigned to locations A+B,
  **not** three duplicate `Cashier-{branch}` roles.
- **The dual gate** (from `LocationServiceImpl` + the authorization checks):
  `checkCrud(role, entity, action)` **AND** `isAssignedToLocation(userId, locationId)`.
- **Owner/co-owner bypass:** `STORE_OWNER` implicitly accesses **all** locations — no explicit
  mapping rows.
- **Our target contract:**
  ```sql
  user_location_mapping (
    id uuid PK, user_fk uuid, location_fk uuid,  -- store derived via location.store_fk
    assigned_by uuid, assigned_at timestamptz, revoked_at timestamptz,
    UNIQUE (user_fk, location_fk)
  )
  ```
  + a `LocationGuard` (or extend `TenantGuard`) that resolves `@LocationContext`, verifies the
  location belongs to the resolved store, and applies the dual gate with owner bypass.
- **Point-in-time note (offline):** the mapping check must also be time-aware on `/sync/delta` —
  `wasAssignedToLocationAt(userId, locationId, asOf)` — mirroring our existing
  `wasCrudAuthorizedAt`. This is *our* addition; the Java app (online-only) doesn't need it.

### 8.2 ADOPT — Head Office **and** Default location, both protected

Java `CompanyLocation` carries **two** flags — `isHeadOffice` and `isDefault` — with hard guards:

| Rule (Java error code) | Adopt as |
|---|---|
| `LOC_C_NOT_DISABLE` — cannot disable Head Office | never disable/delete `is_primary` location |
| `LOC_C_DEFAULT_NOT_DISABLE` — cannot disable the default | never disable the default location |
| `LOC_C_ONLY_DEFAULT` — cannot unset the last default | at least one default must always exist |
| Setting a new default clears the others | exactly one default per store |

- **We have** `is_primary` (Head Office) only. **Add** `is_default` (the location a device opens into)
  + these guards. Cheap; prevents a real self-lockout class of bug.
- **Offline angle:** surface `default_location_id` in the bootstrap snapshot (`rbac.md §26.8`) so an
  offline device knows which location to open without a network call. This is the offline-first
  reason the "default" concept matters *more* for us than for the always-online Java app.

### 8.3 ADOPT — create-with-mandatory-children is one atomic unit

On location create, Java **auto-adds the owner to the location** and **auto-creates a default
storage area**, atomically. We already auto-provision Head Office in the store-create transaction;
generalize the pattern: when branch-location creation lands, create the creator's
`user_location_mapping` (+ any required defaults) in the **same UoW** — a create isn't "done" until
its mandatory children exist.

### 8.4 ADAPT — deterministic, server-derived idempotency keys for periodic money ops

Java's recurring charge uses `idempotencyKey = "plan:{guuid}:{YYYYMM}"` — **derived from
(entity, period)**, not a random client value. A retried charge for the same plan+month can never
double-charge, even with a dumb client.

- **We have** order-scoped idempotency in `BillingService` (keyed on the payment order id) — good for
  one-off checkout.
- **Adapt for recurrence:** when renewals return, key on `(subscriptionId, period)` →
  `pay:{subId}:{YYYYMM}`, not a client token. Safe-by-construction retries.

### 8.5 ADAPT — model the retry state **on the row**, not in code (deferred)

Java `RecurringPlan` carries the whole retry state machine as columns:
`failureCount, maxRetries, retryIntervalDays, nextChargeAt, lastPaymentIntentId,
status ∈ {ACTIVE, ACTION_REQUIRED, PAST_DUE, CANCELED, PAUSED}`. On decline → increment +
reschedule; at `maxRetries` → `PAST_DUE`. The cron becomes a pure `WHERE nextChargeAt <= now` scan.

- **Status: DEFERRED.** Recurrence/past_due were deliberately stripped from our current flow. **This
  is the blueprint for when it returns** — put the retry state on the `account_subscription` row
  (fields, not scattered logic), combine with §8.4's deterministic keys, and the reconciliation cron
  stays a trivial predicate scan.

### 8.6 ADAPT — environment-match guard on webhooks (small, do when webhook goes live)

Java's Stripe webhook rejects events whose `metadata.env` ≠ the running profile — stops a test-mode
event from mutating prod. One `if`. When our **Razorpay webhook** goes live, stamp `env` into order
metadata at checkout and reject mismatches in `handleWebhook`. High value / near-zero cost.

### 8.7 ADOPT (principle) — status transitions centralized; keep our enum, not their `Status` FK

Java models subscription status as a **FK to a `Status` table** (extensible without deploy). **Do
not adopt the FK table** — for us it's over-engineering and it hurts the offline snapshot (an enum
serializes cleanly; an FK needs a join on a device). We already centralize transitions in
`SubscriptionService` — keep the Postgres enum + that single funnel. Take the *principle*, reject the
*mechanism*.

### 8.8 REJECT — right for the ERP, wrong for us

| Java design | Why we reject it |
|---|---|
| **Per-(Company × Application) subscription** | We're single-app POS; one subscription per account is correct + simpler. |
| **App-driven recurring cron, no provider Subscription object** | Razorpay's own subscription + webhooks is less code / less to get wrong for us. Keep our cron minimal (trial-expiry). |
| **Boolean-only features, no numeric entitlements** | We *need* numeric caps. Our `plan_entitlements` + `plan_features` two-table split is strictly better for a limits-driven POS. |
| **No location cap** | They don't gate locations by plan; **we should** (revenue). Do not copy this omission. |
| **`Long id` + `guuid` dual IDs** | Legacy baggage; UUID PKs are simpler and offline/distributed-friendly for us. |
| **Company hierarchy (`isRootCompany`)** | Parent/subsidiary is ERP territory; out of scope for a kirana POS. |
| **ThreadLocal user context** | Java-servlet pattern (and risky under virtual threads even for them); N/A to Node — we use `@nestjs/cls` (§3.9). |

### 8.9 Concrete next-step shortlist (given current code state)

Locations table + device-access are built; subscription is stripped to forward-only. Highest leverage:

1. **`user_location_mapping` + dual-gate `LocationGuard` (+ owner bypass)** — §8.1. Continues the
   layer already started; Java app is the proven blueprint.
2. **`is_default` on locations + disable/delete guards + `default_location_id` in snapshot** — §8.2.
   Small, prevents self-lockout, serves offline startup.
3. **Razorpay webhook env-guard** — §8.6. One `if`, add when the webhook lands.
4. **(Deferred)** period-derived idempotency keys + retry-state-on-row — §8.4/§8.5, for when
   recurrence is reintroduced.

*Added 2026-07-01 from source-level analysis of the Ayphen 3.0 Company/Location/Subscription/Stripe
domain. Verdicts filtered for the offline-first, single-account, Razorpay retail-POS backend.*