# CLAUDE.md — Enterprise Backend Engineering Standard (Generic)

> A stack-agnostic standard for designing and reviewing any enterprise-grade backend. It defines
> the architecture, data & transaction patterns, API design, resilience, security, observability,
> and system-design decisions a production backend must follow — and encodes the common mistakes so
> they're prevented. Use it both ways: **rules when building**, **checklist when reviewing**.
>
> Framework/language-neutral — the principles hold for any stack. Where a stack-specific standard
> exists, this is the umbrella above it.
>
> These are rules, not suggestions. When a rule conflicts with a request, surface it and follow the
> rule unless explicitly overridden.

---

## 0. The twelve principles (highest-order rules)

1. **Separation of concerns.** HTTP layer parses/authorizes/delegates; business logic in services;
   data access in repositories. No logic in the transport layer, no queries in services.
2. **The client is never trusted.** Every id, tenant, amount, and permission is re-validated
   server-side. Client checks are UX only.
3. **Fail closed.** Auth, authorization, and validation deny on ambiguity — never fail open.
4. **Atomicity.** Multi-step writes are transactional; the whole thing commits or rolls back. No
   torn state.
5. **Idempotency.** Anything retryable (webhooks, payments, jobs) dedupes by a key that commits
   with the effect. At-least-once delivery is assumed everywhere.
6. **One source of truth per fact.** Caches, projections, and denormalized copies derive from it
   and are rebuildable. No two authoritative homes for the same data.
7. **Invariants in the database.** Hard rules are constraints (unique, FK, check, partial-unique),
   not just app checks — app checks can be raced.
8. **Bound everything.** Every list paginated, every batch capped, every outbound call
   timed-out, no unbounded loop or query.
9. **Resilience by default.** Timeouts, retries with backoff, graceful degradation; one slow or
   failed dependency must not take the system down.
10. **Errors are typed, mapped, and never swallowed.** Correct status, consistent shape, no
    internal leakage, no empty catches.
11. **Observability is built in.** Structured logs with correlation ids, metrics on critical
    paths, audit for security-relevant events. Debuggable at 2am.
12. **Right-sized.** The simplest design that is correct and safe. Don't over-engineer; don't
    under-engineer the safety-critical paths.

---

## 1. Architecture & layering

- **Layered:** transport (controller/handler) → service (business logic + transactions) → data
  access (repository). Each layer one job; dependencies point downward toward stable abstractions.
- **Feature-first modules / bounded contexts.** Group by domain, not by technical layer at the top.
  A module owns its handler, service, repository, DTOs. Cohesive, independently reasoned, deletable.
- **Cross-cutting concerns are shared and injected** — auth, tenancy, rate-limiting, error mapping,
  logging — not copy-pasted per module.
- **Dependency direction & boundaries.** No circular dependencies. A domain never reaches into
  another domain's internals/data — it calls that domain's public service boundary. Domain logic
  doesn't depend on framework/IO details where it can be kept pure.
- **Config is typed and validated on boot** — no scattered raw env access; the app refuses to start
  with invalid/missing config.
- **Stateless services** — no in-memory state that breaks horizontal scaling; sessions/locks/caches
  externalized.

---

## 2. The request lifecycle

Define an explicit, ordered pipeline; the order is load-bearing:

```
Rate-limit / throttle   → cheap rejects before expensive work
Authentication          → validate identity (token/session), replay protection
Tenant resolution       → resolve + verify tenant from the authenticated context
Authorization           → permission check, fail-closed
Entitlement/quota gate  → plan/limit/write-gate where applicable
Input validation        → shape/type/bounds at the boundary, reject unknown fields
Handler → Service → Repo → thin → logic+tx → data
Response transform      → consistent envelope, correlation id
Error filter            → typed error → correct status + shape, no leakage
```

- Guards/middleware **enforce**, they don't do business logic; each has one responsibility and is
  **applied**, not merely defined, on every route that needs it.
- A **global error handler** maps typed domain errors to status + standard shape; it must NOT
  flatten known 4xx into 500s and must never leak internals/stack traces.
- **Validate at the boundary** before the handler runs; whitelist and forbid unknown fields.

---

## 3. Data & transaction patterns

- **Money is integer minor units** (never float); quantities are fixed-scale decimals; dates are
  timezone-aware and "now" is measured at one well-defined point.
- **Transactions for atomic multi-step writes** — the service opens the tx, passes it to each
  repository call, commits once; any failure rolls back all of it.
- **Idempotency + audit commit in the same transaction as the effect** — the dedupe/audit row and
  the business write are one atomic unit; a crash between them is impossible.
- **Optimistic concurrency** (version column) for master-data edits; **additive/event-sourced** for
  data that must never be conflict-rejected (a completed financial event). Don't optimistic-lock
  genuinely additive data.
- **Atomic claims for limits/counters/slots/sequences** — `INSERT … ON CONFLICT`, a unique
  constraint, or `SELECT … FOR UPDATE` — never check-then-insert (TOCTOU race).
- **Outbox pattern** for events that must not be lost — write the event in the domain transaction,
  drain to the bus/consumer asynchronously; decouples request availability from downstream.
- **Constraints enforce invariants at the DB** — uniqueness, FKs, checks, partial-uniques — so a
  race or a direct write can't violate them.
- **Indexes on hot query paths**; no N+1 (batch/join); every list paginated; no unbounded scan.
- **Migrations safe & reversible** — no blocking locks on large tables, constraints validated
  concurrently, backfills batched, every migration has a down path.
- **Soft-delete vs hard-delete** decided deliberately; retention and erasure (compliance) handled.

---

## 4. Multi-tenancy & data isolation (if multi-tenant)

- **Every tenant table carries the tenant key**; every query filters on it, resolved from the
  authenticated context — never from client input.
- **A fetch/update/delete by id on tenant data is scoped** (`where id = ? AND tenant = ?`). A
  missing tenant filter is a P0 IDOR.
- **The tenant guard resolves and verifies** access before the handler; the resolved tenant is the
  only source the service trusts.
- **Shared/polymorphic tables carry or deterministically resolve the tenant key** so isolation is
  uniform.

---

## 5. API design

- **Resource-oriented, consistent contracts** — correct verbs (GET safe/idempotent, POST creates,
  PUT/PATCH update, DELETE removes), correct status codes (400/401/403/404/409/422/429/5xx used
  precisely), consistent request/response envelope.
- **Idempotency on non-idempotent mutations** that can be retried (idempotency key or natural
  dedupe) — especially payments/creates.
- **Pagination on every list**; bounded batch endpoints; no unbounded responses.
- **Versioning strategy** and backward-compatible contract evolution.
- **Validation coverage** on every input; consistent, field-level error shape.
- **No internal leakage** in responses (no stack traces, internal ids, secrets).

---

## 6. Resilience & reliability

- **Timeouts on every outbound call** (DB, cache, HTTP, queue) + connection-pool limits — a slow
  dependency must not hang the service.
- **Retries with backoff + jitter** on transient failures — paired with idempotency so retries are
  safe.
- **Circuit breakers / bulkheads / graceful degradation** — a dependency outage degrades (fallback,
  queue for later), doesn't cascade into a full outage.
- **Graceful shutdown** — drain in-flight requests, close connections, park/finish queue work on
  SIGTERM.
- **Health & readiness endpoints** — readiness checks critical dependencies; liveness is cheap.
- **Idempotent consumers/webhooks** — redelivery and out-of-order are expected; dedupe and tolerate.
- **Cache is a fast-path, not the source of truth** — every cache-gated decision has a durable
  backstop; cache eviction never loses data.
- **Backpressure** on queues/streams; no unbounded in-memory buffering.

---

## 7. Security

- **Fail closed** on auth/authz/validation ambiguity; the client is never the security boundary.
- **AuthN on every non-public route** (enforced, not just declared); **authz fail-closed**;
  **tenant/row scoping** on every data access.
- **Secrets from a secret store**, validated on boot, never in code/repo/logs; rotated.
- **Parameterized queries only**; no string-built SQL; safe deserialization; no injection surface.
- **Rate limiting** on auth, credential, expensive, and enumeration-prone endpoints.
- **Input validation at the boundary**; never trust client ids/tenant/amounts/status.
- **Sensitive data** encrypted at rest where required, minimized in responses, never logged.
- **Token/session hygiene** — short-lived access, rotating refresh with reuse detection,
  revocation, step-up for sensitive actions.
- **Audit security-relevant events** (denials, privilege changes, auth) append-only and durable.
- **Least privilege** everywhere — service accounts, DB roles, API scopes.

---

## 8. Observability

- **Structured logging** with correlation/trace ids threaded through a request; right levels; no
  secrets/PII in logs.
- **Metrics** on critical paths (latency, error rate, throughput, saturation); actionable alerts.
- **Distributed tracing** across service/dependency boundaries where applicable.
- **Audit trail** for security and compliance events, separate from operational logs.
- **Every error is traceable** to a request and enough context to debug without reproducing.

---

## 9. The common backend mistakes this standard prevents

- Business logic in the transport layer; queries in services.
- Auth/authz guard declared but not applied → open route.
- Tenant filter forgotten on a query → cross-tenant leak (IDOR).
- Idempotency/audit written outside the effect's transaction → drift on crash.
- Check-then-insert on limits/counters → TOCTOU race.
- No transaction on a multi-step write → torn state on partial failure.
- Multiple sources of truth for one fact → guaranteed drift.
- App-only enforcement of a hard invariant with no DB constraint → raceable/bypassable.
- Swallowed errors / empty catch / log-then-continue-as-success.
- Error handler flattening 409/422 into 500 → clients can't react.
- Unbounded list/query → OOM/slow under load; N+1 in a loop.
- No timeout on an outbound call → one slow dependency hangs everything.
- Cache treated as source of truth with no backstop → data loss on eviction.
- Non-idempotent webhook/consumer → double-processing on redelivery.
- Secrets in code/logs; sensitive data unencrypted/over-shared.
- Scattered raw env access; config not validated on boot.
- In-memory state that breaks horizontal scaling.
- Over-engineering: saga/queue/eventual-consistency where a transaction was correct and simpler.
- Under-engineering: a naive path for something with real concurrency/compliance/data stakes.

---

## 10. System-design decisions (decide deliberately for any feature)

- **Sync vs async** — a transactional call, or a queue/outbox + worker? Async only when decoupling
  or durability demands it; a transaction is simpler and often correct.
- **Consistency model** — strong vs eventual; where drift is acceptable, where it isn't.
- **Source of truth** — one authoritative home per fact; derived views rebuildable.
- **Idempotency strategy** — natural vs explicit key; where the dedupe row lives (with the effect).
- **Failure & retry** — partial-failure behavior, what's safe to retry, what needs compensation.
- **Scale path** — hot-path cost at 100x; the bottleneck lock/query/queue; what to index/cache/shard.
- **Reversibility** — one-way doors (schema, public contract, data migration) get extra care;
  two-way doors move fast.
- **Build vs buy** — don't hand-roll solved problems (auth, crypto, retry, queue) without cause.

---

## 11. Testing

- **Risky logic is tested first** — auth/authz, money/tax, concurrency, idempotency, tenancy, sync.
- **Integration tests** exercise real transaction/constraint behavior (tenant isolation,
  point-in-time, TOCTOU) against a real DB, not mocks.
- **Tests assert behavior, not implementation**; the risky paths have coverage before the easy ones.
- **Contract tests** for API stability where consumers depend on it.

---

## 12. Definition of done (self-check for any backend work)

- [ ] Transport thin; logic in service; queries in repository.
- [ ] Client never trusted; every tenant query scoped from authenticated context.
- [ ] Multi-step writes transactional; idempotency/audit in the same tx as the effect.
- [ ] Hard invariants backed by DB constraints; limits/slots claimed atomically.
- [ ] Guards applied (not just defined), correct order, fail-closed.
- [ ] Input validated at the boundary; unknown fields rejected; no client-trusted scope.
- [ ] Errors typed, correct status, consistent shape, no leakage, none swallowed.
- [ ] Timeouts on outbound calls; retryable side-effects idempotent; lists paginated.
- [ ] One source of truth per fact; caches have a durable backstop.
- [ ] Config typed + validated on boot; secrets from a store; nothing sensitive logged.
- [ ] No N+1 on hot paths; indexes cover frequent queries; migrations safe/reversible.
- [ ] Observability: correlation ids, critical-path metrics, audit for security events.
- [ ] Resilient: timeouts, retries+backoff, graceful degradation, graceful shutdown.
- [ ] Right-sized — no needless async/saga/abstraction; no under-hardened safety path.
- [ ] Risky logic tested (auth, money, concurrency, tenancy, idempotency).

If any item fails, the work isn't done.

---

## 13. Rules of engagement (when reviewing existing code)

- Map the modules, the request pipeline + its order, the transaction boundaries, and the
  data-isolation approach first.
- Rank findings: **P0** (auth bypass / tenant leak / data-loss / hang) → **P1** (race / missing tx /
  non-idempotent retry / fail-open) → **P2** (architecture / over- or under-engineering) → **P3**
  (nit).
- Cite `file:line`; confirm guards are *applied*; prove tenant scoping on real queries; verify the
  idempotency row commits with the effect.
- Flag both under-engineering (missing tx/constraint/timeout/backstop) and over-engineering
  (needless queue/saga/abstraction/premature optimization).
- Recognize what's genuinely well-built so it's preserved.
- Don't refactor unless asked — deliver the review and prioritized fixes.

---

*Attach this agent to design or review any enterprise backend to a production-grade standard:
layered feature-first architecture, an explicit ordered request pipeline, transactional and
idempotent data patterns, DB-enforced invariants, strict data isolation, robust API design,
resilience (timeouts/retries/circuit-breakers/outbox), security, observability, the common backend
mistakes caught, deliberate system-design decisions, testing, and a definition-of-done. Stack-
agnostic; the umbrella above any framework-specific standard. Thinking as a principal backend
engineer who has shipped and operated systems at scale.*
