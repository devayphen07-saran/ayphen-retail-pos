# Mobile Post-Login Flow, Response Contracts & Freshness Protocol — Index

> Reverse-engineered from the backend (`apps/api`) and reconciled against every
> real-time scenario. The **backend is the source of truth**; every rule is
> backed by a cited file. Items the backend does not currently support are
> marked **GAP**.
>
> This document was split into focused parts. Use the index below; the
> quick-start (TL;DR) stays here as the entry point.

---

## Parts (logical reading order)

| Part | File | Sections | What it answers |
|---|---|---|---|
| 1 | [Auth & Snapshot](./mobile-01-auth-and-snapshot.md) | §0–2 | mental model · token contract · the signed permission snapshot |
| 2 | [Response Contracts](./mobile-02-response-contracts.md) | §3 (3a–3f) | login / refresh / bootstrap / initial / changes / delta — corrected |
| 3 | [Post-Login Flow](./mobile-03-post-login-flow.md) | §4, §8D | the gated step table + mode/empty-state navigation |
| 4 | [Storage & State](./mobile-04-storage-and-state.md) | §5, §8C, §8E | SecureStore vs SQLite vs on-demand · client state domains · API map |
| 5 | [Freshness](./mobile-05-freshness.md) | §6, §7 | permission freshness (pv-driven) · subscription freshness (weaker) |
| 6 | [Multi-Store Offline](./mobile-06-multi-store-offline.md) | §8, §8B | per-store isolation + switching · `default` vs `last_opened` policy |
| 7 | [Issues, GAPs & Plan](./mobile-07-issues-gaps-and-plan.md) | §9–12 | P0/P1/P2 · GAPs · implementation Phases A,0–6 · end-state |
| 8 | [Loading & UX States](./mobile-08-loading-ux-states.md) | §13 | enterprise-grade loading model |
| 9 | [Client Services & Invariants](./mobile-09-client-services-and-invariants.md) | service catalog · INV-1…8 | the 8 client service modules + the concurrency invariants they must uphold |
| 10 | [Local Database & Storage Tiering](./mobile-10-local-database-schema.md) | SQLite vs SecureStore vs API | every local table + what must stay an API call (never local) |
| 11 | [Client Sync Engine](./mobile-11-sync-engine-client.md) | cold start · delta · push · invariants | how the mobile engine consumes the backend contract (the client counterpart to sync-engine.md) |
| 12 | [Sync Implementation Audit](./mobile-12-sync-implementation-audit.md) | code review vs design | audit of the real `infrastructure/sync` code — what's correct + the gap/fix list (410, early-unlock, monotonic guard) |

**Companion PRDs:** [device-management.md](./device-management.md) ·
[subscription.md](./subscription.md). The offline-expiry write-gate handshake lives in
[device-management.md §30](./device-management.md#30-offline-expiry-write-gating-handshake-resolves-d1).

> Section numbers (§0–§13, §8B–§8E) are preserved across the parts; all `§` cross-references
> resolve to a unique heading in one of the part files.

---

## Post-login quick playbook (TL;DR)

After login succeeds (you hold `access_token` + `refresh_token`):

| Step | Call | Read | Store where | Used for |
|---|---|---|---|---|
| 1 | — | tokens | **SecureStore** | auth header + refresh |
| 2 | `GET /me/bootstrap` | `user`, `snapshot`(+sig+pv), `preferences`, `profile_status`, `subscription` | snapshot → **SecureStore** (verify sig) → hydrate to **memory**; rest → **memory** | routing + permission/subscription gating |
| 3 | — (read bootstrap) | gates | — | maintenance / profile / account-mode / no-store / subscription |
| 4 | — (no network) | active store = `last_opened ?? default ?? (single→open / multiple→picker)` | **memory** | which store to open |
| 5 | `POST /stores/:id/access` | `granted` / `403 limit` | — | claim device slot |
| 6 | `GET /stores/:id/context` | hours, config | memory/SQLite | store header, hours |
| 7 | first time: loop `GET /stores/:id/sync/initial`; else `GET /sync/changes` | rows, `next_delta_cursor` | **SQLite** (per `store_fk`) | offline POS data |
| 8 | `GET /sync/changes` + `POST /sync/delta`; `GET /me/pv` on resume; `POST /auth/refresh` near expiry | changes / results / pv | SQLite + memory | steady-state POS |

**Storage map:** tokens + signed snapshot → **SecureStore** (snapshot hydrated to memory for
gating); 21 synced entities + cursors + mutation queue → **SQLite** (per store); signed media
URLs + live subscription re-checks → **don't persist, call on demand**.

**Two correctness rules:** (1) consume `X-Permission-Snapshot` header on every response +
`/me/pv` on resume → permissions reconcile automatically; (2) subscription does NOT auto-push
(no pv bump) → re-check via write `402/403`, `X-Subscription-Warning`, or periodic bootstrap.

Full detail: [Part 3 flow](./mobile-03-post-login-flow.md) · [Part 6 multi-store](./mobile-06-multi-store-offline.md) ·
[Part 4 storage](./mobile-04-storage-and-state.md) · [Part 5 freshness](./mobile-05-freshness.md) ·
[Part 7 plan](./mobile-07-issues-gaps-and-plan.md) · [Part 8 loading](./mobile-08-loading-ux-states.md) ·
[Part 9 client services & invariants](./mobile-09-client-services-and-invariants.md).
