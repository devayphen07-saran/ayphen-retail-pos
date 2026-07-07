# CLAUDE.md — NestJS Backend System-Design Standard

> An enterprise-grade standard for designing and reviewing the backend (NestJS · Drizzle ORM ·
> PostgreSQL · Redis · multi-tenant · offline-first). It defines the architecture, module design,
> request lifecycle, data & transaction patterns, multi-tenancy, resilience, security, and
> system-design decisions the backend must follow — and encodes the common NestJS mistakes so
> they're prevented. Use it both ways: **rules when building**, **checklist when reviewing**.
>
> **Grounds itself in the app's systems:** the guard chain, tenant isolation, RBAC (store-scoped
> role + location dual gate, point-in-time auth), subscription write-gating, the sync engine
> (idempotency, outbox, cursors), and the audit pipeline. When those exist, follow them; this is
> the umbrella standard over them.
>
> These are rules, not suggestions. When a rule conflicts with a request, surface it and follow the
> rule unless explicitly overridden.

---

## 0. The ten principles (highest-order rules)

1. **Controllers are thin.** Parse → authorize → delegate → respond. No business logic in
   controllers; it lives in services.
2. **Every tenant query is scoped.** No query touches tenant data without a store/account filter
   resolved from the authenticated context — never from client input. No IDOR, ever.
3. **Multi-step writes are transactional.** If two writes must both happen, they're in one
   transaction with rollback. Idempotency/audit rows commit in the SAME transaction as the effect.
4. **Invariants live in the database.** Hard rules (uniqueness, one-primary, limits) are DB
   constraints, not just app checks — app checks can be raced; constraints can't.
5. **Fail closed.** Auth, gates, and validation deny on ambiguity. The client is never the security
   boundary; the server re-validates everything.
6. **Every outbound call has a timeout.** DB, Redis, HTTP, queue — no unbounded wait that can hang
   the service under a slow dependency.
7. **Retryable side-effects are idempotent.** Webhooks, payments, sync mutations dedupe by a key
   that commits with the effect — at-least-once delivery is assumed.
8. **The right amount of machinery.** Use a transaction over a saga, a direct call over a queue,
   until the problem demands more. Don't over-engineer; don't under-engineer safety-critical paths.
9. **Errors are typed, mapped, and never swallowed.** Correct status, consistent shape, no internal
   leakage, no empty catches.
10. **Observability is built in.** Structured logs with correlation ids, metrics on critical paths,
    audit for security-relevant events — traceable at 2am.

---

## 1. Architecture

### Module structure (feature-first, layered within)
```
src/
  main.ts, app.module.ts
  common/            ← guards, interceptors, filters, pipes, decorators (cross-cutting)
  config/            ← typed config, validated on boot (no scattered process.env)
  db/                ← Drizzle schema, migrations, the DB provider/connection
  core/ or shared/   ← cross-domain services (auth, tenant, rbac, sync, audit, redis)
  modules/<domain>/  ← one module per bounded context
    <domain>.controller.ts   ← thin: routes, DTOs, guards
    <domain>.service.ts      ← business logic
    <domain>.repository.ts   ← data access (Drizzle queries)
    dto/                     ← request/response DTOs + validation
    <domain>.types.ts
```

- **One module per bounded context** (auth, stores, products, orders, subscription, sync…). A
  module owns its controller, service(s), repository, DTOs. Cohesive and independently reasoned.
- **Layer within a module:** controller (HTTP) → service (logic) → repository (data). Each layer
  has one job; dependencies point downward.
- **Cross-cutting concerns are `common/` or `core/`, injected** — guards, interceptors, filters,
  the tenant resolver, the RBAC service — not copy-pasted per module.
- **Dependency direction:** modules depend on shared/core abstractions, not on each other's
  internals. No circular module deps. A domain module never imports another domain's repository —
  it goes through that domain's service (a public boundary).
- **The database provider is injected**, not imported ad-hoc; transactions are passed down so a
  service can run a repository call inside a caller's transaction.

### Service design
- Services hold the business logic and own transactions. A service method that does a multi-step
  write opens the transaction and passes it to repository calls.
- Keep services cohesive; split a God service (500+ lines, many unrelated responsibilities) into
  focused ones. A service per aggregate/use-case cluster, not one per module if the module is large.
- Pure domain logic (calculations, rule checks) separated from I/O where it clarifies and helps
  testing.

### Repository design
- Repositories own Drizzle queries; no query strings in services/controllers.
- Every tenant-scoped query takes and applies the tenant filter. A repository method that fetches
  by id also scopes by store/account — never a bare `where id = ?` on tenant data.
- Repositories accept an optional transaction handle so they compose into a caller's transaction.
- No N+1: batch/join instead of per-row queries; paginate every list; bound every query.

---

## 2. The request lifecycle (the guard/interceptor chain)

Define and order the pipeline explicitly; order is load-bearing:

```
Request
  → Throttle/RateLimit guard      (abuse protection, before expensive work)
  → Auth guard (JWT/session)      (identity; validate token, session, replay)
  → Tenant guard                  (resolve + verify store/account from context)
  → Step-up guard (if required)   (MFA recency for sensitive actions)
  → Permissions guard (RBAC)      (role WHAT + location WHERE dual gate)
  → Subscription guard            (write-gate: access_valid_until / reconciliation)
  → ValidationPipe (DTO)          (shape/type/bounds — before the handler)
  → Controller → Service → Repo   (thin → logic+tx → data)
  → Interceptor (transform/log)   (response envelope, timing, correlation)
  → Exception filter              (typed error → correct status + shape, no leakage)
```

- **Guards enforce; they don't do business logic.** Each guard has one responsibility and is
  applied (not just defined) on every route that needs it.
- **The order matters:** throttle before auth (cheap rejects first), auth before tenant (need
  identity to resolve tenant), permissions after tenant (need the store), subscription write-gate
  after permissions. Document the order; a reordered chain is a security bug.
- **A global exception filter** maps typed domain errors to status codes and the standard error
  shape; it must NOT flatten known 4xx errors into 500s, and must never leak internals.
- **A global validation pipe** with whitelist + forbid-unknown so extra fields are rejected.

---

## 3. Data & transaction patterns

- **Money is integer minor units** (paise `bigint`); quantities are `numeric` with defined scale;
  never float for currency.
- **Transactions where multi-step writes must be atomic.** The pattern: service opens the tx,
  passes it to each repository call, commits once; any failure rolls back the whole thing.
- **Idempotency + audit in the same transaction as the effect.** The dedupe row and the business
  write commit together — a crash between them is impossible. Never write the idempotency key in a
  separate step.
- **Optimistic concurrency (row_version)** for master-data edits; **additive/event-sourced** for
  transactional data that must never be conflict-rejected (a completed sale). Don't use optimistic
  locking on genuinely additive data.
- **Atomic claims for limits/counters/slots** — `INSERT … ON CONFLICT`, a unique constraint, or
  `SELECT … FOR UPDATE` — never check-then-insert (TOCTOU race).
- **Sequences under a lock** (per-store, per-year for invoices) — a single atomic
  `UPDATE … RETURNING`, never read-then-write.
- **Outbox pattern** for events that must not be lost — write the event row in the domain
  transaction, drain to the bus/audit async. Decouples request availability from downstream.
- **Migrations are safe & reversible** — no blocking locks on big tables, constraints added
  concurrently or validated, backfills batched, every migration reversible.
- **Constraints enforce invariants** — uniqueness, FKs, checks, partial-uniques (one primary, one
  active slot) at the DB, so a race or a direct write can't violate them.
- **Indexes on hot query paths** — every frequent filter/sort/join backed by an index; verify no
  N+1 or unbounded scan on the hot path.

---

## 4. Multi-tenancy (the isolation standard)

- **Every domain table carries the tenant key** (`store_fk` / `account_fk`); every query filters on
  it, resolved from the authenticated context, never from the request body/params.
- **The tenant guard resolves and verifies** the caller's access to the store/account before the
  handler runs; the resolved tenant is the only source the service trusts.
- **No cross-tenant reads or writes** — a fetch-by-id on tenant data is `where id = ? AND store_fk
  = ?`. A missing tenant filter is a P0 IDOR.
- **Shared/polymorphic tables carry the tenant key too** (or resolve it deterministically) so the
  isolation filter is uniform.
- **RBAC is store-scoped:** role (WHAT) + location assignment (WHERE) dual gate; point-in-time
  authorization for offline mutations (was-authorized-at-timestamp, not "now"); permission-version
  cache-busting on change.

---

## 5. Resilience & reliability

- **Timeouts on every outbound call** (DB, Redis, HTTP, third-party) — a slow dependency must not
  hang the service. Pair with connection-pool limits.
- **Retries with backoff + jitter** on transient failures — and idempotency so retries are safe.
- **Circuit breakers / graceful degradation** on flaky dependencies — a Redis or third-party
  outage degrades (fallback to DB, queue for later), doesn't take the service down.
- **Bounded everything** — pagination on lists, caps on batch sizes, limits on fan-out, no
  unbounded loops/queries.
- **Graceful shutdown** — drain in-flight requests, close connections, finish/park queue work on
  SIGTERM.
- **Health & readiness endpoints** — readiness checks critical dependencies; liveness is cheap.
- **Idempotent webhooks** — provider redelivery is expected; dedupe by provider ref, durable order
  mapping surviving cache TTL (a webhook can arrive after the Redis key expired).
- **Redis is a cache/fast-path, not the source of truth** — every Redis-gated decision has a
  durable DB backstop (idempotency, locks, sessions).

---

## 6. Security standard

- **Fail closed** on auth/authz/validation ambiguity.
- **AuthN on every non-public route** (guard applied, not just defined); **authz fail-closed**;
  **tenant/row scoping** on every data access.
- **Secrets from a secret store/env, validated on boot** — never in code, never logged.
- **Parameterized queries only** (Drizzle handles this) — no string-built SQL, safe deserialization.
- **Rate limiting** on auth, OTP, expensive, and enumeration-prone endpoints.
- **Input validation at the boundary** (DTO + pipe); never trust client ids/tenant/amounts/status.
- **Sensitive data** encrypted at rest where required, minimized in responses, never in logs.
- **JWT/session hygiene** — short-lived access + rotating refresh with reuse detection, JTI
  revocation with a persistent fallback behind Redis, step-up for sensitive actions.
- **Audit security-relevant events** (denials, privilege changes, logins) append-only, via the
  outbox so they survive.

---

## 7. The common NestJS mistakes this standard prevents

- **Business logic in controllers** → untestable, duplicated, coupled to HTTP.
- **Guards defined but not applied** (missing `@UseGuards`/global wiring) → open routes.
- **Tenant filter forgotten on a query** → cross-tenant leak (IDOR).
- **Idempotency/audit written outside the effect's transaction** → drift on crash.
- **Check-then-insert on limits** → TOCTOU race (two requests both pass).
- **No transaction on a multi-step write** → torn state on partial failure.
- **Raw `process.env` scattered** instead of typed, validated config.
- **Injecting the DB everywhere ad-hoc** instead of a provider + passable tx.
- **Swallowed errors / empty catch / logging-then-continuing-as-success.**
- **Exception filter flattening 409/422 into 500** → clients can't react.
- **Unbounded list endpoints** (no pagination) → OOM/slow under load.
- **N+1 queries** in a loop instead of a batch/join.
- **Circular module dependencies** / a domain reaching into another's repository.
- **God services** doing ten unrelated things.
- **Redis treated as source of truth** with no DB backstop → data loss on eviction.
- **No timeout on an outbound call** → one slow dependency hangs the whole service.
- **Blocking the event loop** with heavy sync work → throughput collapse.
- **Sync/async webhook not idempotent** → double-processing on redelivery.
- **`any` on domain types**, DTOs without validation, error shapes inconsistent per module.

---

## 8. System-design decisions (think through these)

For any significant backend feature, decide deliberately:
- **Sync vs async** — a direct transactional call, or a queue/outbox + worker? Use async only when
  decoupling or durability demands it; a transaction is simpler and often correct.
- **Consistency model** — strong (transaction) vs eventual (outbox/projection); where is drift
  acceptable, where is it not?
- **Where's the source of truth** — one authoritative store per fact; caches/projections derive
  from it and are rebuildable.
- **Idempotency strategy** — natural key vs explicit key; where the dedupe row lives (with the
  effect).
- **Failure & retry** — what happens on partial failure, what's safe to retry, what needs
  compensation.
- **Scale path** — the hot path's cost at 100x; the bottleneck lock/query; what to index/cache.
- **Reversibility** — is this a one-way door (schema, contract) needing extra care, or a two-way
  door?

---

## 9. Definition of done (self-check for backend work)

- [ ] Controller thin; logic in service; queries in repository.
- [ ] Every tenant query scoped from authenticated context (no client-trusted tenant).
- [ ] Multi-step writes transactional; idempotency/audit in the same tx as the effect.
- [ ] Hard invariants backed by DB constraints (not app-only).
- [ ] Limits/counters/slots claimed atomically (no check-then-insert).
- [ ] Guards applied (not just defined) in the correct order; fail-closed.
- [ ] DTO validation at the boundary; unknown fields rejected; no client-trusted scope.
- [ ] Errors typed, correct status, consistent shape, no leakage, none swallowed.
- [ ] Timeouts on outbound calls; retryable side-effects idempotent; lists paginated.
- [ ] Config typed + validated on boot; secrets from store; no secrets logged.
- [ ] No N+1 on hot paths; indexes cover frequent queries; migrations safe/reversible.
- [ ] Observability: correlation id, critical-path metrics, audit for security events.
- [ ] Right-sized: no needless async/saga/abstraction; no under-hardened safety path.
- [ ] Risky logic tested (auth, money, concurrency, sync, tenancy).

If any item fails, the work isn't done.

---

## 10. Rules of engagement (when reviewing existing code)

- Map modules, the guard chain + its order, the transaction boundaries, and the tenant-scoping
  approach first.
- Rank findings: **P0** (tenant leak / auth bypass / data-loss / hang) → **P1** (race / missing tx /
  non-idempotent retry) → **P2** (architecture / over- or under-engineering) → **P3** (nit).
- Cite `file:line`; confirm guards are *applied*, not just defined; prove tenant scoping on real
  queries.
- Flag both under-engineering (missing tx/constraint/timeout) and over-engineering (needless
  queue/saga/abstraction).
- Recognize what's genuinely well-built (the idempotency trio, the outbox, the DB-level guards) so
  it's preserved.
- Don't refactor unless asked — deliver the review and prioritized fixes.

---

*Attach this agent to design or review the NestJS backend to an enterprise-grade standard: feature-
first modular architecture, thin-controller/service/repository layering, an explicit ordered
guard chain, transactional and idempotent data patterns, DB-enforced invariants, strict multi-
tenancy, resilience (timeouts/retries/circuit-breakers/outbox), security, the common NestJS
mistakes caught, deliberate system-design decisions, and a definition-of-done — grounded in the
app's tenancy, RBAC, subscription, sync, and audit systems. Thinking as a principal backend
engineer who has shipped and operated multi-tenant systems at scale.*
