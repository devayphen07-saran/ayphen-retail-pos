# Ayphen 3.0 — Complete Architecture Documentation

> Source path: `/Users/saran/Downloads/ayphen-3.0/src`
> Stack: **Spring Boot 3.3.0 · Java 21 · PostgreSQL · Maven**

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Directory Structure](#2-directory-structure)
3. [Application Entry Point](#3-application-entry-point)
4. [Configuration Layer](#4-configuration-layer)
5. [Security & Authentication](#5-security--authentication)
6. [API Layer & Controllers](#6-api-layer--controllers)
7. [Service Layer](#7-service-layer)
8. [Data Access Layer — JPA Repositories](#8-data-access-layer--jpa-repositories)
9. [Domain Entities](#9-domain-entities)
10. [Data Transfer Objects (DTOs)](#10-data-transfer-objects-dtos)
11. [Mapper Layer](#11-mapper-layer)
12. [Exception Handling & Response Wrapper](#12-exception-handling--response-wrapper)
13. [Pagination](#13-pagination)
14. [Validation](#14-validation)
15. [Utility Layer](#15-utility-layer)
16. [Constants & Enumerations](#16-constants--enumerations)
17. [Scheduled Tasks](#17-scheduled-tasks)
18. [Email & Notifications](#18-email--notifications)
19. [Third-Party Integrations](#19-third-party-integrations)
20. [Multi-Tenancy Design](#20-multi-tenancy-design)
21. [Database Schema](#21-database-schema)
22. [Audit & Activity Logging](#22-audit--activity-logging)
23. [WebSocket Support](#23-websocket-support)
24. [Testing](#24-testing)
25. [Deployment & Runtime](#25-deployment--runtime)
26. [Key Architectural Patterns](#26-key-architectural-patterns)
27. [End-to-End Request Flows](#27-end-to-end-request-flows)
28. [Codebase Statistics](#28-codebase-statistics)

---

## 1. Project Overview

Ayphen 3.0 is a **production-grade enterprise ERP REST API** covering:

- Full accounting (General Ledger, Chart of Accounts, reconciliation)
- 49 distinct transaction types (invoices, POs, bills, expenses, payments, refunds …)
- Inventory management
- Customer & supplier (contact) management
- Multi-tenant company isolation with granular role-based permissions
- Banking integration via Plaid
- Payment processing via Stripe
- Document storage via Microsoft Graph / OneDrive
- Multi-currency with scheduled exchange-rate sync

| Attribute | Value |
|-----------|-------|
| Build tool | Maven |
| Java version | 21 |
| Spring Boot | 3.3.0 |
| Primary DB | PostgreSQL (driver 42.7.3) |
| Default port | 8085 |
| Token strategy | JWT (HS512) — access 15 min, refresh 7 days |

---

## 2. Directory Structure

```
src/
├── main/
│   ├── java/com/ayphen/api/
│   │   ├── AyphenMasterApplication.java       ← entry point
│   │   ├── config/                            ← 14 Spring @Configuration classes
│   │   ├── configuration/                     ← additional custom config
│   │   ├── controller/                        ← 79 REST controllers
│   │   ├── domain/                            ← 245 JPA entity classes
│   │   ├── dto/                               ← 425+ DTOs
│   │   ├── entity/                            ← audit-related JPA entities
│   │   ├── exception/                         ← custom exceptions & handlers
│   │   ├── mapper/                            ← 55+ entity↔DTO mappers
│   │   ├── pagination/                        ← pagination request/response
│   │   ├── payload/                           ← extra request/response wrappers
│   │   ├── repository/                        ← 200+ JpaRepository interfaces
│   │   ├── response/                          ← CustomResponse<T> factory
│   │   ├── scheduler/                         ← 3 scheduled-task classes
│   │   ├── security/                          ← JWT filter, config, principal
│   │   ├── service/                           ← 93+ service classes
│   │   ├── utility/                           ← 12+ utility classes
│   │   ├── validation/                        ← custom Bean Validation annotations
│   │   ├── webSocket/                         ← WebSocket handlers
│   │   ├── constant/                          ← 20+ constant/enum files
│   │   └── listener/                          ← JPA & application event listeners
│   └── resources/
│       ├── application.yml                    ← master config
│       ├── application-dev.yml
│       ├── application-test.yml
│       ├── application-local-dev.yml
│       ├── application-rm.yml                 ← client-specific profiles
│       ├── application-km.yml
│       ├── application-ml.yml
│       ├── db-scripts/                        ← 5 SQL DDL / DML files
│       ├── templates/email/                   ← 12+ Thymeleaf HTML templates
│       ├── cert/                              ← SSL keystore + Keycloak cert
│       ├── static/
│       └── realm-setting/                     ← Keycloak realm JSON
└── test/
    └── java/com/ayphen/api/
        ├── AyphenMasterApplicationTests.java
        └── controller/CompanyControllerTest.java
```

---

## 3. Application Entry Point

**`AyphenMasterApplication.java`**

```java
@SpringBootApplication
@EnableScheduling
public class AyphenMasterApplication {
    public static void main(String[] args) {
        SpringApplication.run(AyphenMasterApplication.class, args);
    }
}
```

- Standard Spring Boot auto-configuration
- `@EnableScheduling` activates all `@Scheduled` tasks across the application

---

## 4. Configuration Layer

### 4.1 `application.yml` — Key Properties

**Server**
```yaml
server:
  port: 8085
  ssl:
    enabled: false          # TLS terminated at load balancer in prod
servlet:
  multipart:
    max-file-size: 20MB
    max-request-size: 20MB
```

**JWT**
```yaml
jwt:
  secret: <HS512 key>
  expiration: 900000        # 15 minutes (ms)
  refresh-expiration: 604800000  # 7 days (ms)
```

**AWS S3**
```yaml
aws:
  region: eu-west-1
  bucket: ayphen-backend-for-test
```

**Plaid**
```yaml
plaid:
  environment: sandbox
  rate-limit:
    max-calls: 100
    period-seconds: 60
  retry:
    max-attempts: 3
    backoff: exponential
  thread-pool:
    core: 10
    max: 20
```

**Stripe**
```yaml
stripe:
  secretKey: sk_test_...
  clientId: ca_...
  redirectURL: /stripe/oauth/callback
  webhook:
    dev: whsec_...
    test: whsec_...
    local: whsec_...
```

**Microsoft Graph**
```yaml
graph:
  tenant-id: 38d8636f-...
  client-id: 4319c881-...
  client-secret: <secret>
  user-email: docs@ayphen.com
  poll-interval-ms: 3000
  max-attachment-size-kb: 10240
```

**Exchange Rates**
```yaml
exchangerate:
  base-url: https://api.exchangeratesapi.io/v1
  access-key: <key>
  default-base: EUR
  scheduler.cron: "0 0 */8 * * *"    # every 8 hours
```

**Resilience4j**
```yaml
resilience4j:
  ratelimiter:
    instances:
      plaid:
        limit-for-period: 100
        limit-refresh-period: 60s
  retry:
    instances:
      plaid:
        max-attempts: 3
        wait-duration: 1s
        enable-exponential-backoff: true
  circuitbreaker:
    instances:
      plaid:
        failure-rate-threshold: 50
```

**Actuator**
```yaml
management:
  endpoints:
    web:
      exposure:
        include: health, metrics, prometheus, ratelimiters, retries, circuitbreakers
```

**OpenAPI / Swagger**
```yaml
springdoc:
  server:
    url: http://localhost:8085
  title: Ayphen Master API
```

---

### 4.2 `@Configuration` Classes

| Class | Responsibility |
|-------|---------------|
| `AsyncConfig` | Thread pool executor for `@Async` methods |
| `AuditConfig` | JPA auditing — wires `AuditorAware` to `SecurityContext` |
| `CorsConfig` | Allowed origins, methods, headers, credentials |
| `EmailSchedulerConfig` | Dedicated executor for email queue |
| `PlaidConfig` | Plaid API client, cache (1 000 items / 3 600 s TTL), thread pool |
| `PlaidResilienceConfig` | Resilience4j beans for Plaid rate-limit & retry |
| `RateLimitConfig` | Global rate-limit rules |
| `WebSocketConfig` | STOMP endpoint registration |
| `RecursiveTransactionScheduler` | Recurring-transaction cron bean |

---

## 5. Security & Authentication

### 5.1 Security Configuration

**`CustomSecurityConfig.java`** (`@EnableWebSecurity`, `@EnableMethodSecurity`)

```
CSRF          → disabled (stateless JWT API)
Sessions      → STATELESS
CORS          → CorsConfig bean
Public paths  → /api/v1/auth/**, /swagger-ui/**, /v3/api-docs/**
All others    → require valid JWT
Filter        → JwtAuthenticationFilter added before UsernamePasswordAuthenticationFilter
```

### 5.2 JWT Architecture

#### Token provider — `JwtTokenProvider`

| Method | Description |
|--------|-------------|
| `generateAccessToken(Authentication, Map<> claims)` | Signs HS512 access token (15 min) |
| `generateRefreshToken(String username, Map<> claims)` | Signs HS512 refresh token (7 days) |
| `validateToken(String token)` | Signature + expiry check |
| `isAccessToken / isRefreshToken` | Discriminates token type via claim |
| `getUsernameFromToken` | Extracts `sub` claim |
| `getClaimsFromToken` | Full claims map |

Each token carries a unique `jti` (JWT ID) for tracking/revocation.

**Claims embedded in token:**
```
userId, guuid, firstName, lastName, iamUserId
```

#### Authentication filter — `JwtAuthenticationFilter`

```
1. Extract "Bearer <token>" from Authorization header
2. Validate via JwtTokenProvider
3. Load UserDetails from DB
4. Set Authentication in SecurityContextHolder
5. Populate UserContextHolder (request-scoped)
6. Short-circuit public endpoints
7. Clear UserContextHolder in finally block
```

#### Entry point — `JwtAuthenticationEntryPoint`

Returns `401 Unauthorized` JSON for missing/invalid tokens.

### 5.3 UserPrincipal

```java
public class UserPrincipal implements UserDetails {
    Long   id;
    UUID   guuid;          // global unique identifier
    String firstName;
    String lastName;
    String username;
    String iamUserId;      // IAM system reference
    String password;       // @JsonIgnore
    Boolean isVerified;

    // getAuthorities() → [ROLE_USER]
}
```

### 5.4 Auth Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/v1/auth/register` | Register user, queue verification email |
| POST | `/api/v1/auth/login` | Return access + refresh tokens |
| POST | `/api/v1/auth/refresh` | Rotate refresh token (cookie or body) |
| POST | `/api/v1/auth/logout` | Revoke refresh token |
| POST | `/api/v1/auth/forgot-password` | Send reset email |
| POST | `/api/v1/auth/reset-password` | Apply new password |
| GET | `/api/v1/auth/verify-email` | Confirm email via token |

**Refresh token cookie:** `HttpOnly; SameSite=Lax` — prevents XSS and CSRF.

### 5.5 Auth Service Flow

**Register**
```
1. Unique username check
2. BCrypt password hash
3. Create Users entity (guuid + iamUserId assigned)
4. Async verification email queued
```

**Login**
```
1. AuthenticationManager.authenticate()
2. Verify isVerified flag
3. generateAccessToken + generateRefreshToken
4. Persist RefreshToken entity (expiresAt = now + 7d)
5. Update lastLogin, clear failedLoginAttempts
6. Return LoginResponseDTO { accessToken, refreshToken, expiresIn, user fields }
```

**Refresh**
```
1. Validate refresh token (type, signature, expiry)
2. Revoke (isRevoked = true)
3. Generate new pair
4. Return TokenRefreshResponseDTO
```

### 5.6 Permission System

Authorization uses Spring method security with a custom `PrincipalManager` bean:

```java
@PreAuthorize("@principalManager.checkPermission(authentication, null,
    T(com.ayphen.api.constant.master.PermissionKeyConstants).PERMISSION_NAME_NR)")
```

Permission key constants:
```
PERMISSION_NAME_NR  →  "New Record"    (CREATE)
PERMISSION_NAME_VR  →  "View Record"   (READ)
PERMISSION_NAME_ER  →  "Edit Record"   (UPDATE)
PERMISSION_NAME_DR  →  "Delete Record" (DELETE)
+ many module-specific keys
```

---

## 6. API Layer & Controllers

### 6.1 Controller Convention

```java
@RestController
@RequestMapping("/api/v1/companies/{tenantId}/resource")
@RequiredArgsConstructor
@Tag(name = "...", description = "...")
@SecurityRequirement(name = "bearerAuth")
public class XyzController {
    private final XyzService service;

    @PostMapping
    @PreAuthorize("@principalManager.checkPermission(...)")
    public ResponseEntity<CustomResponse<XyzDTO>> create(
            @PathVariable UUID tenantId,
            @Valid @RequestBody XyzRequestDTO request) {
        return ResponseEntity.ok(service.create(tenantId, request));
    }
}
```

All responses are wrapped in `CustomResponse<T>` (see §12).

### 6.2 Controller Inventory (79 controllers)

| Domain | Key Controllers |
|--------|----------------|
| **Auth** | `AuthController` |
| **Company & Users** | `CompanyController`, `UsersController`, `UsersManagementController`, `ApplicationController` |
| **Master Data** | `MasterAccountsController`, `MasterController`, `MasterPaymentMethodController`, `MasterPaymentDetailsController` |
| **Transactions** | `TransactionController`, `TransactionPrefixController`, `TransactionVerificationController` |
| **Accounting** | `AccountsController`, `AccountStatementController`, `ReportsController`, `AccountMappingController` |
| **Products** | `ProductController`, `ProductTypeController`, `ProductCategoryController`, `ProductSubTypeController`, `ProductSyncController` |
| **Contacts** | `SupplierController`, `CustomerController`, `CustomerStatementController` |
| **Approvals** | `ApprovalController` |
| **Banking** | `PlaidController`, `PlaidWebhookController` |
| **Payments** | `StripeController`, `StripeWebHookController` |
| **Currency** | `ExchangeRateController` |
| **Rules & Routing** | `RoutesController`, `ServiceTaskMapController`, `RecurrenceConfigController` |
| **Support** | `NotificationController`, `FilesController`, `TeamController`, `ActivityLogController` |

### 6.3 Transaction Endpoints (representative)

```
POST   /api/v1/companies/{tenantId}/transactions/draft     Create draft
POST   /api/v1/companies/{tenantId}/transactions/submit    Post to GL
PUT    /api/v1/companies/{tenantId}/transactions/{id}      Update
DELETE /api/v1/companies/{tenantId}/transactions/{id}      Void / reverse
GET    /api/v1/companies/{tenantId}/transactions/{id}      Retrieve
GET    /api/v1/companies/{tenantId}/transactions           List (paginated)
```

---

## 7. Service Layer

### 7.1 Interface + Implementation Pattern

```java
// Interface
public interface ProductService {
    CustomResponse<ProductDTO> create(UUID tenantId, ProductRequestDTO req);
    CustomResponse<ProductDTO> update(UUID tenantId, UUID productId, ProductRequestDTO req);
    CustomResponse<Void> delete(UUID tenantId, UUID productId);
    CustomResponse<ProductDTO> findById(UUID tenantId, UUID productId);
    CustomResponse<PaginationResponse<ProductDTO>> findAll(UUID tenantId, PaginationRequest req);
}

// Implementation
@Service
@RequiredArgsConstructor
@Transactional
public class ProductServiceImpl implements ProductService { ... }
```

### 7.2 Service Inventory (93+ services)

```
service/
├── auth/
│   ├── AuthService.java + impl/AuthServiceImpl.java
├── transaction/
│   ├── TransactionService.java
│   ├── headers/       ← transaction header orchestration
│   ├── journals/      ← journal entry creation
│   ├── adjustments/   ← adjustment transaction logic
│   ├── transactions/  ← 49 type-specific handlers
│   ├── queue/         ← async transaction queue
│   ├── gl/            ← General Ledger posting
│   └── service/       ← shared transaction helpers
├── notification/      ← real-time notification delivery
├── email/             ← email templating & dispatch
├── exchangeRate/      ← rate fetch & caching
├── common/            ← shared helper services
├── implementation/
│   ├── pms/           ← Property Management System
│   ├── subscription/  ← Stripe subscription lifecycle
│   └── transaction/   ← additional transaction support
├── ProductService.java
├── CompanyService.java
├── UsersService.java
├── AccountsService.java
├── ReportsService.java
└── ... (60+ more)
```

### 7.3 Transaction Processing — Business Logic Depth

```
draftTransaction()
  → Validate company + location access for tenantId
  → Create TransactionHeader (status = DRAFT)
  → Create TransactionLine entries
  → Calculate line totals + header total
  → Dispatch to type-specific handler (one of 49)
  → Persist via repository
  → Emit ActivityLog entry

submitTransaction()
  → Change status DRAFT → POSTED
  → Generate GeneralLedger entries (debit/credit pairs)
  → Post to MasterAccount running balances
  → Adjust inventory quantities (if applicable)
  → Create PaymentTransaction link (if applicable)
  → Emit ActivityLog entry
```

---

## 8. Data Access Layer — JPA Repositories

**200+ repositories**, all extending `JpaRepository<Entity, Long>`.

### 8.1 Repository Pattern

```java
@Repository
public interface ProductRepository extends JpaRepository<Product, Long> {

    Optional<Product> findByGuuidAndIsActiveTrue(UUID guuid);

    @Query("SELECT p FROM Product p WHERE p.company.id = :companyId AND p.isActive = true")
    List<Product> findAllActiveByCompany(@Param("companyId") Long companyId, Pageable pageable);

    boolean existsBySkuAndCompanyId(String sku, Long companyId);
}
```

### 8.2 Key Repositories

| Repository | Entity | Notes |
|------------|--------|-------|
| `UsersRepository` | Users | Auth lookups by username |
| `CompanyRepository` | Company | Tenant resolution |
| `CompanyUserRepository` | CompanyUser | User↔tenant mappings |
| `TransactionRepository` | TransactionHeader | Core transaction store |
| `MasterAccountRepository` | MasterAccount | Chart of accounts |
| `ProductRepository` | Product | Inventory |
| `CustomerRepository` | Customer | CRM |
| `SupplierRepository` | Supplier | Procurement |
| `RefreshTokenRepository` | RefreshToken | Token lifecycle |
| `ActivityLogRepository` | ActivityLog | Audit queries |
| `GeneralLedgerRepository` | GeneralLedger | GL reports |

### 8.3 Sub-domain Repository Packages

```
repository/
├── pms/          ← PlaidCredentialRepository, etc.
├── subscription/ ← subscription management repos
└── stripe/       ← Stripe entity repos
```

---

## 9. Domain Entities

### 9.1 Base Entity — Audit Pattern

**`BaseEntity.java`** (`@MappedSuperclass`)

```java
@MappedSuperclass
@EntityListeners(BaseEntityListener.class)
public abstract class BaseEntity {

    @Column(unique = true, nullable = false, updatable = false)
    private UUID guuid;             // global surrogate key exposed in API

    @Column(name = "created_by")
    private Long createdBy;

    @CreationTimestamp
    @Column(nullable = false, updatable = false)
    private Instant createdDate;

    @Column(name = "modified_by")
    private Long modifiedBy;

    @UpdateTimestamp
    private Instant modifiedDate;
}
```

`BaseEntityListener` hooks `@PrePersist` / `@PreUpdate` to pull the acting user from `SecurityContext` and populate the audit columns automatically.

### 9.2 Core Entities

| Entity | Key Fields |
|--------|-----------|
| `Users` | username, passwordHash, isVerified, lastLogin, failedLoginAttempts, accountLockedUntil |
| `Company` | name, registrationNumber, subscriptionStatus |
| `CompanyUser` | user FK, company FK, role, location |
| `CompanyLocation` | address, isHeadquarters |
| `MasterAccount` | accountCode, accountName, accountType, runningBalance |
| `Product` | productCode, productName, category, sku, quantityOnHand |
| `Customer` | customerCode, customerName, paymentTerms, contacts |
| `Supplier` | supplierCode, supplierName, paymentTerms |
| `TransactionHeader` | transactionNumber, transactionDate, status, totalAmount |
| `TransactionLine` | lineNumber, product, quantity, unitPrice, lineTotal |
| `GeneralLedger` | account, debitAmount, creditAmount, reference, postingDate |
| `RefreshToken` | token, user, expiresAt, isRevoked |
| `PasswordResetToken` | token, user, expiresAt |
| `ApplicationEntity` | application, entity (feature-flag per company) |

### 9.3 Transaction Entity Types (49 handlers)

```
BankDepositTransaction          BillPaymentTransaction
CustomerCreditTransaction       DeliveryInTransaction
DeliveryOutTransaction          ExpenseTransaction
InvoicePaymentTransaction       ManualAdjustmentTransaction
POTransaction                   PRTransaction
PurchaseTransaction             RefundBillTransaction
RefundExpnTransaction           RefundInvTransaction
+ 35 additional type-specific entities
```

### 9.4 Relationship Examples

```java
// One company → many locations
@OneToMany(mappedBy = "company", cascade = CascadeType.ALL)
private List<CompanyLocation> locations;

// Transaction header → lines
@OneToMany(mappedBy = "transactionHeader", cascade = CascadeType.ALL)
private List<TransactionLine> lines;

// Many-to-One (most relationships)
@ManyToOne(fetch = FetchType.LAZY)
@JoinColumn(name = "company_fk")
private Company company;

// Many-to-Many (roles)
@ManyToMany
@JoinTable(name = "user_role_mapping")
private Set<Role> roles;
```

---

## 10. Data Transfer Objects (DTOs)

**425+ DTO classes** across all domains.

### 10.1 Organisation

```
dto/
├── auth/
│   ├── LoginRequestDTO
│   ├── LoginResponseDTO
│   ├── TokenRefreshRequestDTO
│   ├── TokenRefreshResponseDTO
│   ├── UserRegistrationRequestDTO
│   ├── UserRegistrationResponseDTO
│   ├── ForgotPasswordRequestDTO
│   ├── ResetPasswordRequestDTO
│   └── LogoutRequestDTO
├── notification/
├── subscription/
├── ProductDTO.java
├── CustomerDTO.java
├── SupplierDTO.java
├── MasterAccountDTO.java
├── TransactionDTO.java
├── CompanyDTO.java
├── ReportingGroupDTO.java
└── ... (400+ more)
```

### 10.2 Auth DTO Shapes

```java
// Registration
UserRegistrationRequestDTO { username, password, firstName, lastName }
UserRegistrationResponseDTO { guuid, username, message }

// Login
LoginRequestDTO  { username, password }
LoginResponseDTO { userGuuid, username, firstName, lastName, iamUserId,
                   accessToken, refreshToken, expiresIn }

// Refresh
TokenRefreshRequestDTO  { refreshToken }
TokenRefreshResponseDTO { accessToken, refreshToken, expiresIn }
```

### 10.3 DTO Conventions

- Lombok `@Data` + `@Builder` on every DTO
- `@Valid` for cascaded validation
- Jackson `@JsonProperty` where field name differs
- Custom `@Constraint` annotations for business rules

---

## 11. Mapper Layer

**55+ mapper classes** — hand-written (no MapStruct), each a Spring `@Component`.

### 11.1 Mapper Pattern

```java
@Component
@RequiredArgsConstructor
public class ProductMapper {

    private final CategoryMapper categoryMapper;

    public ProductDTO toDTO(Product entity) {
        return ProductDTO.builder()
            .id(entity.getId())
            .guuid(entity.getGuuid())
            .productCode(entity.getProductCode())
            .productName(entity.getProductName())
            .category(categoryMapper.toDTO(entity.getCategory()))
            .build();
    }

    public Product toEntity(ProductDTO dto) { ... }

    public void updateEntity(ProductDTO dto, Product entity) {
        entity.setProductName(dto.getProductName());
        // partial update — only non-null fields applied
    }
}
```

### 11.2 Notable Mappers

| Mapper | Notes |
|--------|-------|
| `AccountCodeMapper` | Chart of accounts hierarchy |
| `OptimizedTransactionMapper` | Performance-tuned, avoids N+1 |
| `JournalMapper` | GL entry ↔ DTO |
| `ApplicationEntityMapper` | Feature-flag mapping |
| `OSSRegistrationMapper` | One-Stop-Shop tax registration |
| `TransactionMapper` | Complex, composes 6+ sub-mappers |

---

## 12. Exception Handling & Response Wrapper

### 12.1 `CustomResponse<T>`

Every controller return value is wrapped:

```java
public class CustomResponse<T> {
    Boolean       success;
    int           statusCode;
    String        errorCode;       // application-level error code
    String        message;         // user-friendly message
    T             body;
    LocalDateTime timestamp;
}
```

**Factory methods:**
```java
CustomResponse.success(String message)
CustomResponse.success(String message, T body)
CustomResponse.error(String errorCode, String message)
CustomResponse.of(HttpStatus status, String message, T body)
```

### 12.2 Custom Exceptions

| Exception | Purpose |
|-----------|---------|
| `PlaidException` | Carries Plaid error code + context |
| `PlaidExceptionHandler` | Global handler — retries, then graceful degradation |

### 12.3 Error Code Constants

`ErrorCodeConstants.java` — centralised, localisation-ready, HTTP-status mapped.

---

## 13. Pagination

### 13.1 Request

```java
public class PaginationRequest {
    Integer pageNo;           // 0-based
    Integer pageSize;
    String  sortBy;           // field name
    String  sortDirection;    // "ASC" | "DESC"
}
```

### 13.2 Response

```java
public class PaginationResponse<T> {
    List<T>  content;
    Integer  pageNo;
    Integer  pageSize;
    Long     totalElements;
    Integer  totalPages;
    Boolean  isLast;
    Boolean  isFirst;
}
```

**Spring Data usage:**
```java
Pageable pageable = PageRequest.of(req.getPageNo(), req.getPageSize(),
    Sort.by(direction, req.getSortBy()));
Page<Entity> page = repository.findAll(pageable);
List<EntityDTO> dtos = page.map(mapper::toDTO).getContent();
```

---

## 14. Validation

### 14.1 Bean Validation

Standard Jakarta annotations: `@NotNull`, `@NotBlank`, `@Email`, `@Min`, `@Max`, `@Pattern`, `@Valid`.

### 14.2 Custom Validators (`/validation/` + `/utility/validation/`)

- Multi-field cross-property constraints
- Business-rule validators (e.g. valid account code format)
- Cross-entity uniqueness checks
- Context-aware validators that query the database

---

## 15. Utility Layer

**`/utility/`** — 12+ classes

| Class | Size | Purpose |
|-------|------|---------|
| `CommonUtils.java` | 126 KB | String, collection, generic type helpers |
| `ConversionUtils.java` | 177 KB | Type conversion, number formatting |
| `DateTimeUtils.java` | — | ISO-8601, fiscal-period, timezone ops |
| `TransactionCalc.java` | — | Tax, discount, total calculations |
| `TransactionUtil.java` | — | Transaction-specific formatting helpers |
| `MathUtils.java` | — | BigDecimal rounding, precision control |
| `ExcelCsvUtils.java` | — | Apache POI export helpers |
| `JsonAttributeConverter.java` | — | JPA `AttributeConverter` for JSON columns |

Sub-packages:
```
utility/
├── handler/
│   └── ExchangeRate/   ← rate lookup & formatting
└── helper/             ← domain helper extraction
```

---

## 16. Constants & Enumerations

**`/constant/`** — 20+ files

| File | Contents |
|------|----------|
| `ActivityLogConstants.java` | Log key strings |
| `ActivityLogEntityConstants.java` | Entity type identifiers |
| `ActivityLogMessageConstants.java` | Message templates |
| `CommonConstant.java` | Global app constants |
| `EntityTypeConstants.java` | Domain entity classifications |
| `TransactionQueueStatus.java` | Queue state enum |
| `master/MasterKeyConstants.java` | Master data key strings |
| `master/PermissionKeyConstants.java` | Permission identifiers (NR, VR, ER, DR …) |
| `master/TransactionKeyConstants.java` | Transaction type codes |
| `master/StatusConstant.java` | Status string values |
| `master/LookupConstants.java` | Lookup category identifiers |
| `security/JwtClaims.java` | JWT claim key strings |
| `errorcode/ErrorCodeConstants.java` | Error code → HTTP status mapping |

---

## 17. Scheduled Tasks

**`/scheduler/`** — 3 scheduler classes + `RecursiveTransactionScheduler` in config

| Scheduler | Trigger | Purpose |
|-----------|---------|---------|
| `ApprovalDashboardScheduler` | Every 120 s | Refresh approval workflow dashboard |
| `ExchangeRateScheduler` | `0 0 */8 * * *` (every 8 h) | Fetch & cache latest FX rates |
| `StripeRecurringPlanScheduler` | Configured | Process due subscription renewals |
| `RecursiveTransactionScheduler` | Configured | Auto-generate recurring transactions |

```java
@Component
public class ExchangeRateScheduler {
    @Scheduled(cron = "${exchangerate.scheduler.cron}")
    public void refreshRates() {
        exchangeRateService.fetchAndCacheAll();
    }
}
```

---

## 18. Email & Notifications

### 18.1 Email Service

**`/service/email/EmailServiceImpl.java`** — async, Thymeleaf-rendered HTML

```java
sendVerificationEmail(username, token)
sendPasswordResetEmail(email, resetToken)
sendTransactionNotification(...)
sendInvoiceEmail(...)
sendPurchaseOrderEmail(...)
sendApprovalRequestEmail(...)
sendApprovalStatusEmail(...)
sendTemporaryPasswordEmail(...)
... (12+ methods)
```

### 18.2 Email Templates (`/resources/templates/email/`)

```
email-wrapper.html              ← base layout
paymentLink.html
sendSupplierRequestEmail.html
invoice.html
sla-escalation.html
sendInvite.html
delegate-assignment.html
purchase-order.html
purchase-requisition.html
approval-status.html
approval-request.html
sendTransactionVerification.html
sendTemporaryPassword.html
sendVerifyEmail.html
sendSupplierDisconnectionEmail.html
```

### 18.3 WebSocket Notifications

**`/webSocket/WebSocketNotificationService`**
- STOMP over WebSocket
- User-specific message destinations (`/user/{id}/queue/notifications`)
- Pushed on: transaction status changes, approval actions, system events

---

## 19. Third-Party Integrations

### 19.1 Plaid (Open Banking)

- **Purpose:** Bank account linking, transaction import, identity verification, reconciliation
- **Products:** auth, transactions, identity
- **Countries:** US, CA, GB
- **Reliability:** Resilience4j rate limiter + retry + circuit breaker
- **Caching:** Caffeine, 1 000 entries, 3 600 s TTL
- **Services:** `PlaidService`, `PlaidWebhookController`
- **Webhook events:** account updates, transaction sync

### 19.2 Stripe (Payments)

- **Purpose:** Payment processing, Connect accounts, recurring subscriptions
- **Services:** `StripeService`, `StripeRecurringPlanScheduler`
- **Controllers:** `StripeController` (OAuth + payments), `StripeWebHookController`
- **Webhook events:** payment_intent, invoice, subscription lifecycle events
- **OAuth flow:** Connect → callback → store account token

### 19.3 Microsoft Graph / OneDrive

- **Purpose:** Document storage, email attachment ingestion
- **Auth:** OAuth 2.0 client credentials (tenant + client ID + secret)
- **Polling:** every 3 000 ms for new mail attachments
- **Size limit:** 10 240 KB per attachment
- **Account:** docs@ayphen.com

### 19.4 Exchange Rate API

- **Provider:** exchangeratesapi.io v1
- **Schedule:** every 8 hours via cron
- **Base currency:** EUR
- **Usage:** Transaction currency conversion, multi-currency reporting

---

## 20. Multi-Tenancy Design

### 20.1 Tenant Isolation Strategy

- Every API path is prefixed with `/api/v1/companies/{tenantId}/…`
- `tenantId` is the company's `guuid` (UUID)
- Every service method validates that the calling user belongs to that company
- No shared data accidentally leaks — all queries scope to `company_fk`

### 20.2 Hierarchy

```
Company
└── CompanyLocation (branches / warehouses)
    └── CompanyUser (user assigned to this location)
```

### 20.3 Feature Flags per Tenant

`ApplicationEntity` table links a **Company** to an **Application** (feature module). Only enabled modules are accessible. `CountryAppEntityMap` applies country-level localisation rules (e.g. VAT schemes, tax rules).

### 20.4 User Context

`UserContextHolder` — thread-local, populated by `JwtAuthenticationFilter`, cleared in `finally`. Carries: `userId`, `guuid`, `iamUserId`, `companyId`, `locationId`.

---

## 21. Database Schema

### 21.1 Schema Migration Scripts (`/resources/db-scripts/`)

| File | Purpose |
|------|---------|
| `ayphen-master-ddl.sql` | Core tables — users, company, accounts, contacts |
| `ayphen-pms-ddl.sql` | Property Management System tables |
| `ayphen-master-transaction-ddl.sql` | All transaction tables |
| `ayphen-account-codes-data.sql` | Seed chart-of-accounts data |
| `ayphen-master-initial-data.sql` | Master data seeds (countries, currencies, lookup values) |
| `auth-migration.sql` | Auth schema additions / migrations |

### 21.2 Table Groups

**Authentication**
```
users · refresh_token · password_reset_token · email_verification
```

**Multi-Tenancy**
```
company · company_users · company_location · company_general_settings · company_storage
```

**Accounting**
```
mas_account · general_ledger · account · account_mapping
master_account_type · account_codes
```

**Transactions**
```
transaction_header · transaction_line · transaction_link
payment_transaction_header · delivery_item_details
```

**Inventory**
```
products · product_category · product_storage · product_suppliers
volumes · case_quantities
```

**Contacts**
```
customer · supplier · contact_person · communication
```

**Tax & Payments**
```
tax · tax_mapping · tax_rate · tax_rule
payment_method · payment_details
```

**Master / Reference**
```
country · state_region_province · city · county · currency
lookup · status · routes · roles
```

---

## 22. Audit & Activity Logging

### 22.1 JPA Audit (`BaseEntityListener`)

```java
@PrePersist  → set createdBy from SecurityContext, set guuid via UUID.randomUUID()
@PreUpdate   → set modifiedBy from SecurityContext, modifiedDate via @UpdateTimestamp
```

### 22.2 Activity Log

```java
activityLogService.logActivity(
    entity,           // EntityTypeConstants.PRODUCT
    entityId,         // guuid string
    activityName,     // "Product Updated"
    activityMessage,  // "SKU ABC123 stock changed from 10 to 15"
    userId,
    LocalDateTime.now()
);
```

`ActivityLog` entity is stored in the database, queryable, and exposed through `ActivityLogController` with pagination. Records every user action that mutates data.

---

## 23. WebSocket Support

**`/webSocket/`** — STOMP-based push

```java
@Configuration
@EnableWebSocketMessageBroker
public class WebSocketConfig implements WebSocketMessageBrokerConfigurer {
    @Override
    public void registerStompEndpoints(StompEndpointRegistry registry) {
        registry.addEndpoint("/ws").setAllowedOriginPatterns("*").withSockJS();
    }
    @Override
    public void configureMessageBroker(MessageBrokerRegistry config) {
        config.enableSimpleBroker("/topic", "/queue");
        config.setApplicationDestinationPrefixes("/app");
    }
}
```

`WebSocketNotificationService` pushes events to individual user queues. Used for: approval status, transaction post confirmation, sync completion.

---

## 24. Testing

### 24.1 Test Stack

- JUnit 5
- Mockito
- Spring Boot Test (`@SpringBootTest`)
- REST Assured
- JsonPath

### 24.2 Test Files

| File | Type |
|------|------|
| `AyphenMasterApplicationTests.java` | Integration — context loads |
| `controller/CompanyControllerTest.java` | Controller-level unit tests |

### 24.3 Test Dependencies (Maven)

```xml
spring-boot-starter-test
mockito-core
junit-jupiter-api / junit-jupiter-engine
rest-assured
json-path
```

---

## 25. Deployment & Runtime

### 25.1 Build

```
mvn clean package
→ ayphen-3.0-0.0.1-SNAPSHOT.jar  (fat JAR)
```

Spring Boot Maven Plugin bundles all dependencies. Lombok is excluded from the final artifact.

### 25.2 SSL

- `cert/keystore.p12` — PKCS12 keystore (SSL disabled in dev; terminated at LB in prod)
- `cert/keycloak_cert.pem` — for validating Keycloak tokens

### 25.3 Actuator Endpoints

| Endpoint | Purpose |
|----------|---------|
| `/actuator/health` | Liveness / readiness |
| `/actuator/metrics` | JVM & app metrics |
| `/actuator/prometheus` | Prometheus scrape endpoint |
| `/actuator/ratelimiters` | Live Resilience4j rate-limiter state |
| `/actuator/retries` | Retry statistics |
| `/actuator/circuitbreakers` | Circuit breaker state |

### 25.4 Spring Profiles

```
spring.profiles.active: go    # default in application.yml
```

Profile override at start:
```bash
java -jar app.jar --spring.profiles.active=dev
```

---

## 26. Key Architectural Patterns

### 26.1 Layered Architecture

```
HTTP Request
     ↓
Controller        (@RestController, @PreAuthorize)
     ↓
Service           (@Service, @Transactional)
     ↓
Mapper            (@Component, entity ↔ DTO)
     ↓
Repository        (JpaRepository)
     ↓
Domain Entity     (@Entity, BaseEntity)
     ↓
PostgreSQL
```

### 26.2 Design Patterns Applied

| Pattern | Where |
|---------|-------|
| **Dependency Injection** | Throughout — `@RequiredArgsConstructor` |
| **Repository** | 200+ `JpaRepository` interfaces |
| **DTO** | 425+ classes isolate API contract from entity |
| **Mapper** | 55+ mappers — explicit, testable, no magic |
| **Service / Interface + Impl** | Every service has a separating interface |
| **Factory** | `CustomResponse.success()` / `.error()` |
| **Singleton** | All Spring beans |
| **Template** | `BaseEntity` + `BaseEntityListener` for audit |
| **Observer** | `@EntityListeners`, `ApplicationEventPublisher` |
| **Strategy** | 49 transaction type handlers — polymorphic dispatch |
| **Proxy** | Spring AOP — `@Transactional`, `@PreAuthorize`, `@Async` |
| **Decorator** | `CustomResponse<T>` wrapping every response |
| **Resilience** | Resilience4j — rate limiter + retry + circuit breaker on Plaid |

### 26.3 Transaction Management

```java
@Transactional             // write operations — rollback on any RuntimeException
@Transactional(readOnly = true)  // list/get — skips dirty checking, faster
```

---

## 27. End-to-End Request Flows

### 27.1 Authentication Flow

```
POST /api/v1/auth/register
  → AuthController.register()
  → AuthServiceImpl.registerUser()
      → UsersRepository.existsByUsername()         // uniqueness check
      → BCrypt.encode(password)
      → UsersRepository.save(newUser)              // guuid + iamUserId generated
      → emailService.sendVerificationEmail() async
  ← 200 { guuid, username, message }

POST /api/v1/auth/login
  → AuthController.login()
  → AuthServiceImpl.loginUser()
      → AuthenticationManager.authenticate()       // credential check
      → assert user.isVerified
      → jwtTokenProvider.generateAccessToken()
      → jwtTokenProvider.generateRefreshToken()
      → refreshTokenRepository.save()              // TTL = 7 days
      → usersRepository.save()                     // lastLogin, failedAttempts = 0
  ← 200 { accessToken, refreshToken, expiresIn, user fields }
     Set-Cookie: refreshToken=...; HttpOnly; SameSite=Lax
```

### 27.2 Protected Request Flow

```
GET /api/v1/companies/{tenantId}/products
  → JwtAuthenticationFilter
      → extract "Bearer <token>"
      → JwtTokenProvider.validateToken()
      → UserDetailsService.loadUserByUsername()
      → SecurityContextHolder.setAuthentication()
      → UserContextHolder.set(userId, companyId, …)
  → DispatcherServlet → ProductController.list()
  → @PreAuthorize → PrincipalManager.checkPermission() → PERMISSION_NAME_VR
  → ProductService.findAll(tenantId, paginationRequest)
      → ProductRepository.findAllActiveByCompany(companyId, pageable)
      → ProductMapper.toDTO(list)
  ← 200 { success: true, body: { content, totalElements, … } }
     // UserContextHolder cleared in filter finally block
```

### 27.3 Transaction Processing Flow

```
POST /api/v1/companies/{tenantId}/transactions/draft
  → TransactionController.draft()
  → TransactionService.draftTransaction(tenantId, request)
      → validateCompanyAccess(tenantId, userContext)
      → TransactionHeader.create(status = DRAFT)
      → TransactionLine.createAll(request.lines)
      → typeHandler = resolveHandler(request.transactionType)   // one of 49
      → typeHandler.process(header, lines)
      → TransactionRepository.save(header)
      → activityLogService.log("Transaction Drafted", …)
  ← 200 { transactionId, transactionNumber, status: "DRAFT" }

POST /api/v1/companies/{tenantId}/transactions/submit
  → TransactionService.submitTransaction(tenantId, transactionId)
      → header.setStatus(POSTED)
      → glService.generateEntries(header)       // debit/credit pairs
          → MasterAccount.updateBalance()       // running balance
          → GeneralLedger.save(entries)
      → inventoryService.adjust(lines)          // if stock movement
      → paymentService.link(header)             // if payment attached
      → TransactionRepository.save(header)
      → activityLogService.log("Transaction Posted", …)
  ← 200 { transactionId, status: "POSTED", glEntriesCount }
```

---

## 28. Codebase Statistics

| Component | Count |
|-----------|-------|
| Java source files | ~1 832 |
| REST Controllers | 79 |
| Service classes | 93+ |
| DTOs | 425+ |
| JPA Entities | 245 |
| JPA Repositories | 200+ |
| Mapper classes | 55+ |
| Configuration classes | 14 |
| Constant / enum files | 20+ |
| Scheduler classes | 4 |
| SQL scripts | 5 |
| Email templates | 12+ |
| YAML config profiles | 11 |
| Test classes | 2+ |

---

*Generated from source analysis of `/Users/saran/Downloads/ayphen-3.0/src` — 2026-06-30*
