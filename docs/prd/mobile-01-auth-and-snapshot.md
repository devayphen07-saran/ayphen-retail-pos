# Mobile Architecture · Part 1 — Auth, Tokens & the Permission Snapshot

> Part of the [Mobile Post-Login & Freshness](./MOBILE_POST_LOGIN_AND_FRESHNESS.md) series.
> Backend is the source of truth; every rule is backed by a cited file. **GAP** = not supported today.

---

## 0. Mental model — two enforcement layers

1. **Client-side optimistic gate** — show/hide UI and allow/block offline actions
   off the **cached signed permission snapshot**. Fast, offline-capable, may be stale.
2. **Server-side authoritative gate** — every request re-checks live
   `permissionsVersion` (`PermissionsGuard` busts its cache when
   `jwt.pv ≠ user.permissionsVersion`) and live subscription state.

**The client can never be more permissive than the server.** When the two
disagree, the server returns `403`/`402` and the client reconciles. Gate
optimistically; treat the server's error + the pushed snapshot as truth.

---

## 1. Auth & token contract

| Property | Value | Source |
|---|---|---|
| Token model | JWT access + opaque refresh + DB-backed `device_session` | `auth/mobile/services/mobile-auth.service.ts:700`, `refresh-token.service.ts` |
| Access token | EdDSA JWT, `iss=ayphen-retail`, `aud=mobile`, **TTL 1h** | `mobile-auth.service.ts:32`, `crypto.service.ts:77` |
| Refresh token | 32-byte, stored as SHA-256 hash, **TTL 30d**, single-use, rotated each refresh | `refresh-token.service.ts:13,61-172` |
| JWT claims | `sub`(userId), `sid`(sessionId), `did`(deviceId), `pv`(permissionsVersion), `jti`, `iss/aud/iat/exp` | `crypto.service.ts:116-133` |
| NOT in JWT | role, permissions, storeId, account-mode — delivered via the signed snapshot | `crypto.service.ts:20-31` |

**Login is OTP-only, two-stage** (`login.dto.ts:13-17`):
1. `POST /api/v1/auth/mobile/login {method:"otp", phone}` → `{otp_sent, expires_in, otp_request_id?}`
2. `POST /api/v1/auth/mobile/login {method:"otp", phone, otpCode, otp_request_id, device:{publicKey, platform,...}}`
   → tokens + user.

**Required headers on every authenticated request** (`auth/mobile/guards/mobile-jwt.guard.ts`):
- `Authorization: Bearer <jwt>`
- `x-nonce` + `x-timestamp` — **mandatory**; missing → `401 replay_protection_required`; timestamp within ±5 min.
- `x-store-id` *or* `:storeId` path param on store-scoped routes (most data/sync routes use the path param).
- `x-client-mode: offline-replay` on replayed offline mutations (triggers `online_required` on `@OnlineOnly` routes).

**Clock:** read `x-server-time` (on every response) to compute the offset used for
`x-timestamp` and for stamping `client_modified_at` on mutations.

---

## 2. The single source of truth — the permission snapshot

A signed (Ed25519, dedicated key) document, verifiable offline, **7-day TTL**.

```
PermissionSnapshot {
  version, userId, issuedAt, expiresAt,
  systemRoles: string[],
  stores: [{
    store_id, store_guuid, store_name,
    roles: string[], is_owner,
    crud:    { [Entity]: { view, create, edit, delete } },   // PascalCase entity codes
    special: { [Entity]: string[] },                          // SCREAMING_SNAKE action codes
    offline_allowed_entities: string[],
    offline_constraints: {...},
    subscription: SnapshotSubscriptionPayload | null
  }],
  personal: {...}
}
```
Source: `auth/core/crypto.service.ts:48-69`.

**Delivered on four channels** (so a dedicated bootstrap is rarely needed):
- `bootstrap` — always.
- `refresh` — inline when `snapshot_changed`, `null` when unchanged.
- `sync/delta` — piggybacked when the client's `permissions_version` is stale.
- **`X-Permission-Snapshot` + `X-Permission-Snapshot-Sig` response headers on _any_
  authenticated response** where `jwt.pv < user.permissionsVersion`
  (`auth/mobile/interceptors/snapshot-refresh.interceptor.ts`, global `APP_INTERCEPTOR`).

**Permission identity for client gating:**
- CRUD = `(Entity PascalCase, view|create|edit|delete)`
- special = `(Entity, SCREAMING_SNAKE actionCode)`
- No string-concatenated form; **no per-user overrides** — effective perms = union of role grants (`snapshot.service.ts:124-152`).

**Scale note — keep the snapshot bounded.**
The snapshot lists **only the stores _this user_ can access**, each with a per-entity `crud` map
(~28 entities). It does **not** contain other users, the catalog, or invitations.
- **Kirana target (1–3 stores): a few KB — non-issue.**
- **Enterprise chain (one owner, 100+ stores): ~50–100 KB** — borderline. **Phase-2 lever (only if
  needed):** carry only the **active store's** `crud` in the snapshot and **lazy-fetch other stores'
  permission detail on switch** (`GET /me/snapshot?store=:id`). Trade-off: this gives up the
  **zero-network store switch** ([mobile-06 §8.4](./mobile-06-multi-store-offline.md)). Don't build it
  until a real multi-100-store owner exists — for the target app, the full snapshot is correct.
