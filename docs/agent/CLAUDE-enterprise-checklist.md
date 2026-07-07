# CLAUDE.md — Enterprise-Grade Engineering Checklist (Senior/Staff Standard)

> The comprehensive checklist for building and shipping software at an enterprise, senior/staff
> engineer standard. It defines what "production-grade" actually means across every dimension —
> correctness, architecture, security, reliability, data, performance, API/contract, testing,
> observability, delivery, and craft — and encodes the judgment a senior engineer applies.
>
> Use it two ways: as a **self-check before shipping** (does this meet the bar?), and as a
> **review checklist when auditing** existing code or a design. Stack-agnostic; where a
> stack-specific standard exists, this is the umbrella above it.
>
> The mindset it encodes: **think in systems and failure modes, not features; make the right thing
> easy and the wrong thing hard; leave the codebase better than you found it; the simplest design
> that is correct, safe, and operable wins.**

---

## 0. The senior-engineer mindset (the meta-standard)

Beyond any checklist item, enterprise-grade work reflects these:

1. **Systems thinking** — consider the whole system, its failure modes, and second-order effects,
   not just the happy path of the feature.
2. **Failure-first design** — design for what happens when things break (they will), before the
   happy path. Every dependency fails; every request retries; every actor can be malicious.
3. **Right-sized** — the simplest solution that is correct, safe, and operable. Neither
   over-engineered (needless complexity) nor under-engineered (naive on a critical path).
4. **Reversibility awareness** — know which decisions are one-way doors (schema, public contract,
   data migration) and give them the care they deserve; move fast on two-way doors.
5. **Ownership** — you own it in production: it must be observable, debuggable, and operable at
   2am by someone who isn't you.
6. **Leave it better** — consistency with the codebase, no new mess, the next engineer can change
   it safely.
7. **Explicit tradeoffs** — decisions are made deliberately, with the tradeoff named, not by
   default or habit.

---

## 1. Correctness & logic

- [ ] The happy path is correct, and every failure/edge path has defined behavior.
- [ ] Concurrency handled — no races, lost updates, or double-processing under simultaneous actors.
- [ ] Multi-step operations are atomic (transaction/rollback); no torn/partial state.
- [ ] Idempotency on anything retryable (at-least-once is assumed); dedupe key commits with the effect.
- [ ] Edge/degenerate inputs handled — empty, null, max, negative, first-run, migration-time.
- [ ] Time handled correctly — timezones, clock skew, expiry/grace boundaries, "now" at one point.
- [ ] Business rules/invariants enforced at a level that can't be bypassed (DB > service > client).
- [ ] No off-by-one, no silent truncation, correct numeric types (money in minor units, not float).

## 2. Architecture & design

- [ ] Clear separation of concerns; each layer/module one responsibility.
- [ ] Feature-first/bounded-context organization; cohesive, deletable modules.
- [ ] Dependencies point toward stable abstractions; no circular deps; no reaching into internals.
- [ ] One source of truth per fact; derived data is rebuildable, not a second authority.
- [ ] Cross-cutting concerns shared and injected, not copy-pasted.
- [ ] Right patterns for the problem — no CQRS/saga/microservice ceremony where a transaction fits;
      no naive monolith where the scale genuinely needs decomposition.
- [ ] Stateless where it must scale horizontally; state externalized.
- [ ] Interfaces/boundaries are minimal and stable; implementation details hidden.

## 3. Security

- [ ] AuthN on every non-public entry point (enforced, not just declared).
- [ ] AuthZ fail-closed; least privilege; deny on ambiguity.
- [ ] Row/record-level scoping — a caller can only ever access data they're entitled to (no IDOR).
- [ ] Tenant/owner resolved from authenticated context, never trusted from client input.
- [ ] Input validated at the boundary; never trust client ids/amounts/status/permissions.
- [ ] No injection surface — parameterized queries, safe deserialization, output encoding.
- [ ] Secrets from a secret store, validated on boot, never in code/logs; rotated.
- [ ] Sensitive data encrypted at rest where required, minimized in responses, never logged.
- [ ] Rate limiting on auth/OTP/expensive/enumeration-prone endpoints.
- [ ] Token/session hygiene — short-lived access, rotating refresh with reuse detection, revocation.
- [ ] Security-relevant events audited (auth, denials, privilege changes), append-only.
- [ ] Dependencies free of known-critical vulns; supply chain considered.

## 4. Reliability & resilience

- [ ] Timeout on every outbound call (DB, cache, HTTP, queue); no unbounded wait.
- [ ] Retries with backoff + jitter on transient failures, paired with idempotency.
- [ ] Circuit breakers / graceful degradation — a dependency outage degrades, doesn't cascade.
- [ ] Bounded everything — pagination, batch caps, fan-out limits, no unbounded loops/queries.
- [ ] Graceful shutdown — drain in-flight work, close connections on SIGTERM.
- [ ] Health/readiness endpoints; readiness checks critical dependencies.
- [ ] Idempotent consumers/webhooks — redelivery and out-of-order tolerated.
- [ ] Cache is a fast-path with a durable backstop; eviction never loses data.
- [ ] Backpressure on queues/streams; no unbounded in-memory buffering.
- [ ] Failure is contained — one component/feature failing doesn't take the system down.

## 5. Data & persistence

- [ ] Schema models the domain correctly; ids consistent; relationships and FKs sound.
- [ ] Invariants enforced by DB constraints (unique, FK, check, partial-unique), not app-only.
- [ ] Transactions where atomicity is required; correct isolation level.
- [ ] Migrations safe (no blocking locks on big tables), reversible, backfills batched.
- [ ] Indexes on hot query paths; no N+1; no unbounded scans; tenant keys indexed.
- [ ] Concurrency control chosen deliberately (optimistic vs additive vs locking) per data type.
- [ ] Soft vs hard delete deliberate; retention and data-erasure (compliance) handled.
- [ ] No duplicate/drifting sources of truth; denormalization intentional and maintained.

## 6. Performance & scale

- [ ] Hot paths identified and efficient; no accidental O(n²)/N+1/full-scan on them.
- [ ] Queries bounded and indexed; heavy aggregation precomputed/cached where appropriate.
- [ ] Caching where it helps, with a correct invalidation story.
- [ ] Behavior understood at 100x load; the bottleneck lock/query/queue known.
- [ ] No blocking the critical thread/event loop with heavy synchronous work.
- [ ] Payload sizes reasonable; pagination/streaming for large data.
- [ ] Resource usage bounded (memory, connections, file handles); no leaks.
- [ ] Premature optimization avoided; optimization targeted at measured hot paths.

## 7. API & contracts

- [ ] Resource-oriented, consistent contracts; correct verbs and status codes.
- [ ] Idempotency on retryable mutations (key or natural dedupe).
- [ ] Pagination on every list; bounded batch endpoints.
- [ ] Input validation coverage; consistent, field-level error shape.
- [ ] No internal leakage in responses (stack traces, internal ids, secrets).
- [ ] Versioning strategy; backward-compatible evolution; consumers not broken silently.
- [ ] Contract documented and matches implementation.

## 8. Error handling & messaging

- [ ] No swallowed errors; every failure path has a defined outcome.
- [ ] Errors typed, mapped to correct status, consistent shape; known errors not flattened to 500.
- [ ] Transactional rollback on failure; no partial commit reported as success.
- [ ] Fail-closed on ambiguous errors in security/gate paths.
- [ ] User-facing messages are clear, non-technical, actionable; no raw/internal text to users.
- [ ] Necessary messages shown; unnecessary/noisy ones suppressed; right surface for each.
- [ ] Internal error detail logged with context; not leaked to the client.

## 9. Observability & operability

- [ ] Structured logging with correlation/trace ids; right levels; no secrets/PII in logs.
- [ ] Metrics on critical paths (latency, errors, throughput, saturation); actionable alerts.
- [ ] Distributed tracing across boundaries where applicable.
- [ ] Audit trail for security/compliance events, separate from operational logs.
- [ ] Every error traceable to a request with enough context to debug without reproducing.
- [ ] Runbook/operational notes for the non-obvious failure modes.
- [ ] Feature flags / config allow safe rollout and quick disable of risky paths.

## 10. Testing & quality gates

- [ ] Risky logic tested first — auth, money, concurrency, idempotency, tenancy, sync.
- [ ] Integration tests exercise real transaction/constraint/isolation behavior, not just mocks.
- [ ] Edge and failure paths tested, not only the happy path.
- [ ] Tests assert behavior, are deterministic, and are readable.
- [ ] Contract tests where consumers depend on the API.
- [ ] Coverage meaningful on critical paths (not chasing a % on trivial code).
- [ ] CI runs type-check, lint, tests; green is required to merge.

## 11. Code quality & maintainability

- [ ] Readable — intent-revealing names, small cohesive functions, shallow nesting, guard clauses.
- [ ] Precise types; no `any` on domain logic; correct nullability; domain types over primitives.
- [ ] No duplication of logic/rules (or it's deliberate and named); no drifted copies.
- [ ] Consistent with the codebase's conventions; reads like one author.
- [ ] Comments explain *why*, not *what*; no stale comments, no commented-out code, no debug logs.
- [ ] No dead code; no needless abstraction; no over-generic single-use layers.
- [ ] Change-safety — hidden coupling minimized; the next engineer can edit without surprises.
- [ ] Error boundaries / containment so one failure doesn't cascade.

## 12. Delivery & lifecycle

- [ ] Change is appropriately scoped; PR reviewable; commits meaningful.
- [ ] Migrations and deploys are safe, ordered, and reversible; rollback plan exists.
- [ ] Backward compatibility maintained during rollout (contract, schema, data).
- [ ] Feature flagged if risky; can be disabled without a deploy.
- [ ] Documentation updated (contract, runbook, ADR for significant decisions).
- [ ] Monitoring/alerts in place before the feature carries real traffic.
- [ ] Rollout plan (canary/staged) for high-risk changes.

## 13. Product & UX correctness (where applicable)

- [ ] The feature actually solves the user's problem, not just the literal ask.
- [ ] Loading/empty/error/success states all handled; no dead-ends or blank screens.
- [ ] Actions give feedback; destructive actions confirm; nothing is silently lost.
- [ ] Accessibility respected; consistent with the product's patterns.
- [ ] Offline/degraded behavior defined (if the app is offline-capable).

---

## 14. How to use this as a review

When auditing code or a design against this checklist:
- **Map first** — the system shape, the change, the critical paths.
- **Walk the relevant sections** — not every section applies to every change; pick the ones that do
  and be honest about which you're skipping and why.
- **Rank findings by real risk** — **P0** (exploitable / data-loss / down) → **P1** (correctness/
  race/reliability gap) → **P2** (architecture/quality/over- or under-engineering) → **P3** (nit).
- **Cite `file:line`** for every finding; confirm, don't assume (guards applied, scoping on real
  queries, idempotency in the effect's tx).
- **Judge proportionately** — weight by centrality and blast radius; a hot-path/core-domain issue
  outranks a leaf nit.
- **Flag both directions** — under-engineering (missing safety) and over-engineering (needless
  complexity).
- **Certify what's sound** — name what genuinely meets the bar so it's preserved.
- **Deliver the gap to enterprise-grade** — for each area, what's missing to meet the standard, and
  the concrete fix. Don't refactor unless asked.

---

## 15. The one-line bar

**Enterprise-grade means: correct under concurrency and failure, secure and tenant-isolated,
resilient to dependency outages, observable and operable in production, backed by tests on the
risky paths, consistent and maintainable — and no more complex than it needs to be to achieve all
of that.**

If a change can't check the sections that apply to it, it isn't done.

---

*Attach this agent as the enterprise-grade bar for building or reviewing software at a senior/staff
standard. As a build self-check: does this change meet the sections that apply? As a review: walk
the relevant sections, rank findings by real risk, cite `file:line`, flag both under- and
over-engineering, certify what's sound, and state the concrete gap to enterprise-grade. It encodes
the senior mindset — systems thinking, failure-first design, right-sizing, reversibility awareness,
production ownership — across correctness, architecture, security, reliability, data, performance,
API, errors/messaging, observability, testing, code quality, delivery, and UX. Thinking as a
principal engineer who ships and operates systems at scale.*
