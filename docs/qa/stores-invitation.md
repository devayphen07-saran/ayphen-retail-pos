# QA Test-Case Report — Store Invitations

**Module:** `apps/backend/src/stores/invitation/`
**Files reviewed:** `invitation.service.ts`, `invitation.repository.ts`, `invitation.controller.ts`,
`invitation.mapper.ts`, `dto/invitation.dto.ts`, `dto/invitation.response.ts`, plus supporting code
read for QA-mode ground truth: `db/schema.ts` (`invitations`, `stores`, `users`, `userRoleMappings`
tables), `stores/role/role.repository.ts`, `common/rbac/guards/tenant.guard.ts`,
`auth/mobile/guards/subscription-status.guard.ts`, `auth/core/rate-limit.service.ts`,
`common/rbac/rbac.repository.ts`, `common/error-codes.ts`, `common/exceptions/app.exception.ts`.

Generated per `docs/agent/CLAUDE-ba-qa-testcases.md`.

---

## 1. Feature understanding (BA)

### What it does
Lets a store admin (holder of `Invitation.create` permission) invite a phone number or email to
join their store with a specific **custom** role. The invitee — who may or may not have an account
yet — receives an out-of-band link (SMS/email, delivery itself is a TODO/stub in the code) carrying
a raw bearer token. Redeeming the token (or, once logged in, accepting by id from an in-app list)
grants account membership + the role atomically. The invite can also be declined, and it expires
automatically after a fixed TTL.

### Actors
- **Inviter** — an authenticated staff member with `Invitation.create` permission scoped to the
  store (`@RequirePermissions({ entity: 'Invitation', action: 'create' })`, store-scoped via
  `@StoreContext('param.storeId')`).
- **Invitee** — the phone/email owner. Two accept/reject surfaces:
  - **Token-based** (`POST /invitations/accept`, `POST /invitations/reject`) — out-of-band link,
    any authenticated user, no store scoping (`@Controller('invitations')`, only `MobileJwtGuard`).
  - **In-app / id-based** (`POST /invitations/:id/accept`, `POST /invitations/:id/reject`,
    `GET /me/invitations`) — for a logged-in user browsing invites addressed to their own verified
    contact info; no token is echoed back to the client.
- **System** — rate limiter, RBAC cache invalidation, permission-snapshot rebuild, audit log.

### Inputs / outputs
- Create: `{ role_id: uuid, phone?: string(≤20), email?: string(email) }` → `{ id, token }` (raw
  token, 200/201).
- Accept (token): `{ token: string(1–64) }` → `{ store_id, snapshot, snapshot_signature }`.
- Accept (id): `:id` (uuid) → same shape.
- Reject (token/id): → `{ ok: true }`.
- List mine: → `[{ id, store_id, store_name, role_name, expires_at }]`.

### State machine
`invitations.status`: `pending → accepted | revoked | expired` (all terminal; no path back to
`pending`). Transitions:
| From | To | Trigger |
|---|---|---|
| (none) | pending | `create()` |
| pending | accepted | `accept()` / `acceptById()`, gated by `markAccepted` CAS |
| pending | revoked | `reject()` / `rejectById()` (invitee decline) — **there is no admin/inviter-side revoke endpoint** (see Open Questions) |
| pending | expired | lazily, only as a side effect of a *later* `create()` call for the exact same store+role+contact (`expireStalePending`) — nothing sweeps expiry on a schedule |

### Business rules / invariants extracted from code
- **BR-1 (contact required):** at least one of `phone`/`email` must be present — 422
  `INVITATION_CONTACT_REQUIRED` (validation-shaped, not a conflict).
- **BR-2 (role must exist, be store-scoped, not soft-deleted):** `findRoleInStore` filters
  `roleId + storeId + deletedAt IS NULL` — 404 `ROLE_NOT_FOUND` otherwise.
- **BR-3 (no system roles via invite):** `SYSTEM_ROLE_CODES` (e.g. `STORE_OWNER`, `USER`,
  `SUPER_ADMIN`) can never be the invited role — 403 `ROLE_NOT_ASSIGNABLE`.
- **BR-4 (one live pending invite per store+role+contact):** enforced twice — an app-level
  pre-check (`findPendingInvite`, TOCTOU-able) and a DB partial unique index
  (`uk_invitations_pending_phone` / `uk_invitations_pending_email`, scoped to `status='pending'`)
  as the real race guard. Violation → 409 `INVITATION_ALREADY_PENDING` either way.
- **BR-5 (stale pending invites self-heal, but only lazily):** before inserting a new invite for the
  same store+role+contact, any existing `pending` row for that exact triple whose `expiresAt` has
  already lapsed is flipped to `status='expired'` first, so it can't collide with the unique index.
  This sweep is scoped to **the exact store+role+contact of the new invite being created** — an
  unrelated stale invite (different role, different contact) is never touched by it.
  This is the *only* place `expired` is ever written.
- **BR-6 (token is the sole redemption credential, hashed at rest):** `token` = SHA-256 hash of
  `randomBytes(24).toString('base64url')` (32 chars); only the raw value (returned once, at create
  time) is redeemable — a DB read/leak never yields a usable token.
- **BR-7 (accept requires pending AND unexpired):** `assertAcceptable` checks
  `status === 'pending'` then `expiresAt < now()` → 409 `INVITATION_NOT_PENDING` or 403
  `INVITATION_EXPIRED` respectively.
- **BR-8 (reject requires pending only — no expiry check):** `reject()`/`rejectById()` check
  `status === 'pending'` but **never check `expiresAt`** — see Edge Case E-1, a real inconsistency
  vs. BR-7.
- **BR-9 (id-based accept/reject authorization = contact match, not ownership):** for `:id` routes,
  the caller must have `invitation.phone === caller.phone` or `invitation.email === caller.email`
  (exact string equality, case-sensitive, no normalization anywhere in the codebase). Mismatch →
  404 `INVITATION_NOT_FOUND` (not 403 — deliberately indistinguishable from "doesn't exist", so the
  endpoint can't be used to enumerate/confirm who was invited).
- **BR-10 (accept/reject race is resolved by a status CAS, not by locking first):** `markAccepted`
  / `markRevoked` are `UPDATE ... WHERE id = ? AND status = 'pending'` — whichever of a concurrent
  accept/reject/retried-accept commits first wins; the loser gets `false` back and the caller raises
  409 `INVITATION_NOT_PENDING`. The per-store `SELECT ... FOR UPDATE` (`lockStore`) is taken first in
  `applyAccept`, serializing *creates* and *accepts* against the same store, but does not by itself
  decide accept-vs-accept — the CAS does.
- **BR-11 (membership + role grant is idempotent):** `ensureAccountMembership` uses
  `onConflictDoNothing`; `insertAssignmentIfAbsent` inserts into `userRoleMappings` with
  `onConflictDoNothing` against the unique key `(userFk, roleFk, storeFk)` — safe for a retried
  `applyAccept()`, **except** when a row already exists in a `revokedAt IS NOT NULL` state (see
  Edge Case E-2 — a serious functional gap).
- **BR-12 (no store-side cancel/list of sent invites):** the only controller in this module that
  creates invites (`StoreInvitationController`) exposes `POST` only — there is no `GET` to list a
  store's outstanding invitations and no revoke/cancel action for the inviter. Only the invitee can
  end a pending invite early (`reject`/`rejectById`). Confirmed by grep: `InvitationService` is
  wired only into `stores.module.ts`; no other controller lists/revokes on the admin side.
- **BR-13 (store-locked / subscription-lapsed does not block accept):** `POST /invitations/accept`,
  `:id/accept`, `reject`, `:id/reject` are guarded only by `MobileJwtGuard` — no `TenantGuard`, no
  `SubscriptionStatusGuard`, no store-locked check anywhere in `applyAccept`/`grantMembershipAndRole`.
  Creating an invite, by contrast, sits behind `TenantGuard + PermissionsGuard +
  SubscriptionStatusGuard`, which blocks writes on a locked/soft-deleted/lapsed-subscription store.
  So a store can go locked/deleted/lapsed **after** invite creation and the invite can still be
  accepted (see Edge Cases E-3, E-4).
- **BR-14 (contact matching is exact-string, unnormalized):** no phone/email normalization
  (lower-casing, E.164, trimming) exists anywhere in the backend (confirmed by grep). Duplicate
  detection (BR-4) and contact-match authorization (BR-9) both do exact equality, so
  `Jane@Example.com` and `jane@example.com` are different contacts to this code.

### Acceptance criteria (inferred)
1. A store admin with permission can invite a phone or email to a specific custom role, once per
   contact+role while a prior invite for that pair is still live.
2. The invitee can redeem the invite exactly once, before expiry, to gain store membership + the
   role — via the delivered token or via an in-app list matched to their verified contact.
3. The invitee can decline instead, and neither path can be "double-applied" under any race.
4. RBAC state (permission cache, session snapshot) reflects the new membership immediately after
   accept.
5. Every create/accept event is audited.

### Assumptions flagged (used by cases below where noted)
- **A1:** "expired" is a defined status but effectively cosmetic/lazy — there is no cron/job that
  flips `pending → expired` on schedule; treat `GET /me/invitations`' `expiresAt` filter and
  `assertAcceptable`'s runtime check as the actual enforcement, not the `status` column.
- **A2:** Delivery (SMS/email send) is out of scope for this code (explicit `// TODO`) — cases below
  test only the record/token lifecycle, not delivery.
- **A3:** "linking to a new vs existing user account" is not a distinct code path here — invitations
  aren't tied to a `userFk` at all until acceptance; a phone/email with no existing account can still
  receive/hold a pending invite (it's matched to a future `users.phone/email` row at accept time via
  session identity, not looked up at create time). This is confirmed by BR-14/A3 combined: create-
  time does **not** validate the contact against any existing `users` row.
- **A4:** "linking an invite to a new or existing user" therefore really means: whichever account the
  invitee is logged into at the moment they call `accept`/`acceptById` is the one that receives
  membership+role — there is no reconciliation if that account's phone/email differs from the
  invited contact on the token path (see Edge Case E-5).

---

## 2. Coverage plan

| Dimension | Cases planned | Why |
|---|---:|---|
| Happy path | 6 | create, accept-by-token, accept-by-id, reject-by-token, reject-by-id, list-mine |
| Business rules (satisfied + violated) | 20 | BR-1..BR-14, each both ways where applicable |
| Boundaries | 8 | TTL boundary, token length, phone length, empty list, many pending invites |
| Negative / invalid | 10 | malformed uuid/token, missing fields, wrong role store, injection-shaped input |
| Failure & recovery | 6 | snapshot rebuild failure, Redis down for rate limit, DB unique violation race, retried accept |
| Concurrency | 7 | double-accept, accept-vs-reject, double-create, concurrent create+accept |
| Permissions / roles | 8 | non-privileged inviter, cross-store role, system-role invite, contact mismatch |
| State transitions | 6 | every legal + illegal transition of the 4-state machine |
| Cross-cutting (tenancy/time/consistency) | 9 | locked store, soft-deleted store, subscription lapsed, clock/TTL edges, cache/snapshot consistency |
| UX | 4 | list rendering of near-expiry invites, empty state, token param shape errors |
| **Total** | **~84** | |

---

## 3. Test cases

### 3.1 Happy path

**TC-001 / Create invitation — phone only**
Area: happy · Criticality: High · Traces to: BR-1, acceptance criterion 1
Preconditions: Actor is `STORE_MANAGER`-equivalent staff of store S with `Invitation.create`;
custom role "Cashier" (role_id `R1`) exists in S; no pending invite for phone `+919812345670` + `R1`.
Input: `POST /stores/S/invitations { role_id: R1, phone: "+919812345670" }`.
Steps: 1) Call endpoint as inviter.
Expected: 201 with `{ id, token }` (token is a 32-char base64url string); DB row created with
`status='pending'`, `token` = SHA-256(raw token) (never the raw value), `expiresAt` = now + 7 days;
audit log `ROLE_ASSIGNMENT_CREATED` (prefix "Invitation") written in the same transaction.

**TC-002 / Create invitation — email only**
Area: happy · Criticality: High · Traces to: BR-1
Same as TC-001 with `email: "cashier.jane@example.com"`, no phone. Expected: same as TC-001.

**TC-003 / Create invitation — both phone and email**
Area: happy · Criticality: Medium · Traces to: BR-1
Input: both `phone` and `email` set to values with no existing pending invite for `R1`.
Expected: 201; row stores both; a duplicate-check with either contact alone (TC on BR-4) would now
match this invite.

**TC-004 / Accept via token (out-of-band link)**
Area: happy · Criticality: Critical · Traces to: BR-6, BR-7, BR-10, BR-11, acceptance criterion 2
Preconditions: pending, unexpired invite for role `R1` in store S; raw token `T` from creation;
invitee logged in as user `U` (fresh account, no prior membership in S's account).
Input: `POST /invitations/accept { token: T }` as `U`.
Steps: 1) Call endpoint.
Expected: 200 `{ store_id: S, snapshot: <non-null PermissionSnapshot>, snapshot_signature: <string> }`;
DB: invitation `status='accepted'`, `acceptedBy=U`, `acceptedAt` set; `account_users` row for U +
S's account exists; `user_role_mappings` row `(U, R1, S)` exists with `revokedAt=null`; RBAC user-store
cache and permission snapshot cache for U invalidated and rebuilt; audit log
`ROLE_ASSIGNMENT_CREATED` (entity `UserRoleMapping`) written.

**TC-005 / Accept via in-app id (GET /me/invitations flow)**
Area: happy · Criticality: Critical · Traces to: BR-9, BR-7, BR-11
Preconditions: user `U`'s verified `users.phone` (or `.email`) exactly equals the invite's contact;
invite `I` pending/unexpired.
Input: `GET /me/invitations` (as U) → returns `I`; then `POST /invitations/I.id/accept` as U.
Expected: `GET` lists `I` with correct `store_name`/`role_name`/`expires_at`; `POST` returns 200 same
shape as TC-004; same DB side effects as TC-004.

**TC-006 / Reject via token**
Area: happy · Criticality: High · Traces to: BR-8
Preconditions: pending invite, raw token `T`.
Input: `POST /invitations/reject { token: T }` — caller may be any authenticated user (token is the
proof, not identity).
Expected: 200 `{ ok: true }`; DB `status='revoked'`; no membership/role granted; invitation can never
be accepted afterward (TC-014).

**TC-007 / Reject via in-app id**
Area: happy · Criticality: Medium · Traces to: BR-8, BR-9
Preconditions: as TC-005 but caller calls `:id/reject` instead.
Expected: 200 `{ ok: true }`; `status='revoked'`.

**TC-008 / List my pending invitations — multiple stores**
Area: happy · Criticality: Medium · Traces to: acceptance criterion 2
Preconditions: user's verified phone has 2 live pending invites from 2 different stores.
Input: `GET /me/invitations`.
Expected: 200, array of 2, each with correct `store_id/store_name/role_name/expires_at`
(ISO 8601 string); no other user's invites present (tenancy — see also §Cross-cutting).

---

### 3.2 Business rules (satisfied + violated)

**TC-010 / BR-1 satisfied — phone provided, no email**
Covered by TC-001. ✓

**TC-011 / BR-1 violated — neither phone nor email**
Area: rule · Criticality: High · Traces to: BR-1
Input: `POST /stores/S/invitations { role_id: R1 }`.
Expected: 422 `INVITATION_CONTACT_REQUIRED`, no row created.

**TC-012 / BR-2 satisfied — role exists in store, not deleted**
Covered by TC-001. ✓

**TC-013 / BR-2 violated — role_id from a different store**
Area: rule · Criticality: High · Traces to: BR-2
Preconditions: role `R2` belongs to store S2, not S.
Input: `POST /stores/S/invitations { role_id: R2, phone: "+91..." }`.
Expected: 404 `ROLE_NOT_FOUND` (cross-tenant role reference correctly rejected, not leaked as 403).

**TC-014 / BR-2 violated — soft-deleted role**
Area: rule · Criticality: Medium · Traces to: BR-2
Preconditions: role `R1` in S has `deletedAt` set (previously deleted).
Input: invite with `role_id: R1`.
Expected: 404 `ROLE_NOT_FOUND` — `findRoleInStore` filters `deletedAt IS NULL`.

**TC-015 / BR-3 satisfied — custom role assignable**
Covered by TC-001. ✓

**TC-016 / BR-3 violated — attempt to invite as STORE_OWNER**
Area: rule · Criticality: Critical · Traces to: BR-3 (privilege-escalation guard)
Input: `role_id` = the store's `STORE_OWNER` system role id.
Expected: 403 `ROLE_NOT_ASSIGNABLE`, no row created. Must hold even if the actor themself is the
current STORE_OWNER (prevents minting a second owner via invite instead of the dedicated
ownership-transfer flow).

**TC-017 / BR-3 violated — attempt to invite as global USER/SUPER_ADMIN role id**
Area: rule · Criticality: Critical · Traces to: BR-3
Input: `role_id` of a system-wide role (`storeFk IS NULL`).
Expected: 404 `ROLE_NOT_FOUND` first (since `findRoleInStore` also filters `storeFk = S`, a
system-wide role never matches any store) — confirms defense-in-depth (would be `ROLE_NOT_ASSIGNABLE`
if the query ever matched).

**TC-018 / BR-4 satisfied — second invite after first resolved**
Area: rule · Criticality: High · Traces to: BR-4
Preconditions: prior invite for (S, R1, phone P) is now `accepted` or `revoked`.
Input: new invite for (S, R1, P).
Expected: 201 — non-`pending` prior rows never collide with the partial unique index.

**TC-019 / BR-4 violated — duplicate live pending invite, same contact+role**
Area: rule · Criticality: Critical · Traces to: BR-4
Preconditions: pending invite exists for (S, R1, phone P).
Input: repeat the exact same create call.
Expected: 409 `INVITATION_ALREADY_PENDING`, no second row created, no partial data written.

**TC-020 / BR-4 boundary — same contact, different role**
Area: rule · Criticality: Medium · Traces to: BR-4
Preconditions: pending invite for (S, R1, phone P).
Input: invite (S, R2, phone P) — different role, same contact, same store.
Expected: 201 — allowed; uniqueness is scoped per (store, role, contact), not per contact alone. Now
two pending invites exist for the same phone in different roles of the same store — if both are
later accepted (by whichever account claims that phone), the user ends up with two roles in S (not
tested here — see TC-047 concurrency).

**TC-021 / BR-5 — stale pending self-heals on re-invite after TTL**
Area: rule · Criticality: High · Traces to: BR-5, A1
Preconditions: invite for (S, R1, phone P) created 8 days ago, still `status='pending'` in DB
(never accepted/rejected, nothing swept it).
Input: new invite for (S, R1, P).
Expected: 201 — `expireStalePending` flips the old row to `status='expired'` inside the same
transaction/lock before the insert, so no `INVITATION_ALREADY_PENDING` conflict; two rows now exist,
the old one `expired`, the new one `pending`.

**TC-022 / BR-6 — token never recoverable from DB**
Area: rule · Criticality: Critical · Traces to: BR-6 (security invariant)
Steps: Inspect the `invitations.token` column directly after TC-001.
Expected: value is a 64-hex-char SHA-256 digest, not the raw token returned to the client; the raw
token cannot be derived from it (one-way hash) — a DB dump/leak alone is not sufficient to redeem
any invite.

**TC-023 / BR-7 satisfied — accept before expiry**
Covered by TC-004. ✓

**TC-024 / BR-7 violated — accept after expiry (status still 'pending' in DB)**
Area: rule / boundary · Criticality: High · Traces to: BR-7, A1
Preconditions: invite created 7 days + 1 second ago (or clock advanced past `expiresAt`), never
touched by `expireStalePending` (no later create() for the same triple happened).
Input: `POST /invitations/accept { token: T }`.
Expected: 403 `INVITATION_EXPIRED` — note the DB row's `status` is still literally `'pending'` at
this point; enforcement is the runtime `expiresAt < now()` check, not the status column (A1).

**TC-025 / BR-7 violated — accept a revoked invitation**
Area: rule / state · Criticality: High · Traces to: BR-7, state machine
Preconditions: invite rejected (TC-006) — `status='revoked'`.
Input: accept the same token.
Expected: 409 `INVITATION_NOT_PENDING`.

**TC-026 / BR-7 violated — accept an already-accepted invitation (replay)**
Area: rule / state / negative · Criticality: Critical · Traces to: BR-7, BR-10
Preconditions: invite already accepted by user U1 (TC-004).
Input: same raw token replayed by U1 again, and separately by a different user U2.
Expected: both calls → 409 `INVITATION_NOT_PENDING`; no additional membership/role rows; no double
audit entries; U2 gains nothing even holding a leaked/forwarded valid-looking token string, because
`markAccepted`'s CAS only succeeds once ever.

**TC-027 / BR-8 — reject after expiry succeeds (inconsistency vs BR-7)**
Area: rule / negative · Criticality: High · Traces to: BR-8 (see Edge Case E-1 for full discussion)
Preconditions: same setup as TC-024 (expired but DB status still `pending`).
Input: `POST /invitations/reject { token: T }`.
Expected (per current code): 200 `{ ok: true }`, row flips to `status='revoked'` — **reject has no
expiry check**, unlike accept. Flag to product/dev: should rejecting an already-expired invite be a
no-op/404 instead of silently succeeding? See Open Questions Q1.

**TC-028 / BR-9 satisfied — id-accept, contact matches**
Covered by TC-005. ✓

**TC-029 / BR-9 violated — id-accept, contact does not match caller**
Area: rule / permission · Criticality: Critical · Traces to: BR-9 (authorization boundary)
Preconditions: invite `I` addressed to phone `+91...111`; caller `U2`'s verified phone is
`+91...222` (different number, no email set on the invite either).
Input: `POST /invitations/I.id/accept` as U2.
Expected: 404 `INVITATION_NOT_FOUND` (not 403) — deliberately indistinguishable from a non-existent
id, so U2 cannot use response codes to enumerate who else was invited to the store.

**TC-030 / BR-9 boundary — id-accept, caller has neither phone nor email set**
Area: rule / edge · Criticality: Medium · Traces to: BR-9
Preconditions: caller `U3.phone = null`, `U3.email = null` is impossible per the
`users_email_or_phone` CHECK constraint — so this precondition cannot occur; document as
structurally prevented. Instead test: caller has only `email` set, invite addressed only by
`phone` → `addressedToCaller` evaluates false (neither `phone` term nor `email` term matches, since
invite.phone exists but caller has none to compare, and invite.email is null) → 404
`INVITATION_NOT_FOUND`.

**TC-031 / BR-10 — concurrent accept vs reject on the same token**
See Concurrency §3.6 TC-050.

**TC-032 / BR-11 satisfied — first-time accept grants membership+role cleanly**
Covered by TC-004. ✓

**TC-033 / BR-11 violated — re-accept after prior revocation of the same role mapping (critical gap)**
Area: rule / state · Criticality: **Critical** · Traces to: BR-11 (see Edge Case E-2 for full detail)
Preconditions: user U was previously granted role R1 in store S via an earlier invite, then an admin
revoked that role assignment (`userRoleMappings.revokedAt` set, via the store's role-unassign flow —
outside this module but same `(userFk, roleFk, storeFk)` row). A **new** invitation is created for
(S, R1, U's contact) and U accepts it.
Input: accept the new invite as U.
Expected (per current code): invitation `status→accepted`, `ensureAccountMembership` no-ops (already
a member), but `insertAssignmentIfAbsent`'s `onConflictDoNothing` against the existing
`(U, R1, S)` row **does nothing** — `revokedAt` stays non-null. The API call returns 200 success and
the audit log claims `ROLE_ASSIGNMENT_CREATED`, but the user's role assignment is still functionally
revoked (no permissions). This is a **silent-failure business-rule gap**: accept "succeeds" without
actually restoring access. Flag to dev — likely needs `insertAssignmentIfAbsent` to become an upsert
that clears `revokedAt` on conflict. See Open Questions Q2.

**TC-034 / BR-12 — no cancel path for the inviter (documented gap, not a bug per se)**
Area: rule / UX gap · Criticality: Medium · Traces to: BR-12
Steps: As the inviter, attempt to find any endpoint to view outstanding invites for store S or
cancel one sent to the wrong contact.
Expected: none exists in this module. The only way to stop a live invite is for the invitee to
reject it, or to wait out the 7-day TTL (during which BR-4 blocks re-inviting that exact
contact+role). Document as a product gap — see Open Questions Q3.

**TC-035 / BR-13 — accept succeeds against a store locked after invite creation**
See Cross-cutting §3.9 TC-070.

**TC-036 / BR-14 — case-sensitive email mismatch blocks legitimate accept**
See Edge Case E-6.

---

### 3.3 Boundaries

**TC-040 / Expiry boundary — exactly at expiresAt**
Area: boundary · Criticality: High · Traces to: BR-7, time edge (§5)
Preconditions: system clock (or test clock) exactly equals `invitation.expiresAt` at the instant of
the accept call.
Input: accept at `t = expiresAt`.
Expected: the check is `expiresAt < now()`, so `now() == expiresAt` is **not** less-than →
acceptance is still allowed at the exact boundary instant; the invite is only expired the moment
`now()` strictly exceeds `expiresAt`. Verify this exact-boundary behavior explicitly (off-by-one
risk).

**TC-041 / Expiry boundary — 1 second after expiresAt**
Area: boundary · Criticality: High
Input: accept at `expiresAt + 1s`.
Expected: 403 `INVITATION_EXPIRED`.

**TC-042 / Token length — minimum accepted (1 char)**
Area: boundary · Criticality: Low · Traces to: DTO schema `token: min(1).max(64)`
Input: `POST /invitations/accept { token: "x" }`.
Expected: passes DTO validation (not 400), proceeds to hash+lookup, returns 404
`INVITATION_NOT_FOUND` (no matching hash) — confirms the length bound is purely a wire-shape guard,
not a correctness check.

**TC-043 / Token length — 65 chars (over max)**
Area: boundary / negative · Criticality: Low
Input: token string of 65 characters.
Expected: 400 from Zod validation (`parse()` throws) before reaching the service — confirm exact
error shape/code used by `parse()`.

**TC-044 / Phone length — exactly 20 chars**
Area: boundary · Criticality: Low · Traces to: DTO `phone: max(20)`
Input: phone string of exactly 20 characters.
Expected: accepted by DTO; create proceeds normally.

**TC-045 / Phone length — 21 chars**
Area: boundary / negative · Criticality: Low
Input: 21-char phone string.
Expected: 400 validation error, no row created.

**TC-046 / List-mine — zero pending invitations**
Area: boundary / UX · Criticality: Medium · Traces to: §5 empty state
Preconditions: user has no verified contact matching any invite (or has none at all).
Input: `GET /me/invitations`.
Expected: 200, `[]` (empty array), not 404/null. If the user record itself has no phone/email at
all (structurally impossible per CHECK, but if contact lookup itself returns null e.g. user
deleted mid-request) `listMyInvitations` returns `[]` defensively.

**TC-047 / List-mine — defensive cap at 500 rows**
Area: boundary · Criticality: Low · Traces to: `listPendingForContact` `.limit(500)`
Preconditions: (synthetic/contrived) 501 stores have all independently sent live pending invites to
the same phone number.
Input: `GET /me/invitations`.
Expected: exactly 500 rows returned, no pagination cursor, no error — documented as a "defensive
cap, not real pagination" in code; confirm no ordering guarantee is required by product (no
`ORDER BY` present, so which 500 of 501 is returned is unspecified — flag as Open Question Q4 if
determinism matters).

---

### 3.4 Negative / invalid input

**TC-050 / Create — malformed role_id (not a uuid)**
Area: negative · Criticality: Medium
Input: `{ role_id: "not-a-uuid", phone: "+91..." }`.
Expected: 400 Zod validation error (`role_id: z.string().uuid()`), no DB access attempted.

**TC-051 / Create — malformed email**
Area: negative · Criticality: Medium
Input: `{ role_id: R1, email: "not-an-email" }`.
Expected: 400 Zod validation error.

**TC-052 / Create — storeId in path is not a uuid**
Area: negative · Criticality: Low
Input: `POST /stores/abc/invitations`.
Expected: 400 from `ParseUUIDPipe`, before any guard/service logic runs.

**TC-053 / Accept — malformed uuid for :id route**
Area: negative · Criticality: Low
Input: `POST /invitations/not-a-uuid/accept`.
Expected: 400 from `ParseUUIDPipe`.

**TC-054 / Accept — token for an invitation that never existed**
Area: negative · Criticality: Medium
Input: random 32-char base64url string not corresponding to any invite.
Expected: 404 `INVITATION_NOT_FOUND` — must be indistinguishable in timing/response from an
expired/wrong-status invite lookup to avoid enumeration (verify no timing side-channel; hashing a
non-existent token still costs the same as a real lookup, so this should already hold).

**TC-055 / Create — role_id belongs to a store the actor has no access to at all**
Area: negative / permission · Criticality: High
Input: `role_id` valid but scoped to store S3, which the actor cannot access.
Expected: 404 `ROLE_NOT_FOUND` (role lookup is scoped to the path's `storeId`, so a role from an
unrelated, even inaccessible, store never matches) — no information leak about S3's existence.

**TC-056 / Create — SQL/NoSQL-injection-shaped phone string**
Area: negative / security · Criticality: Medium
Input: `phone: "'; DROP TABLE invitations; --"`.
Expected: parameterized query (Drizzle) treats it as a literal string; either 400 (exceeds 20 chars,
likely) or stored verbatim as inert text; no injection possible.

**TC-057 / Create — email with leading/trailing whitespace**
Area: negative / edge · Criticality: Medium · Traces to: BR-14
Input: `email: "  jane@example.com  "`.
Expected: Zod's `.email()` does not trim by default — verify actual behavior: either rejected as
invalid email format, or stored with whitespace intact (in which case it will never match a
normalized `contact.email` at accept time → BR-9 mismatch). Flag whichever occurs to dev (Open
Question Q5).

**TC-058 / Accept — token field present but empty string**
Area: negative / boundary · Criticality: Low
Input: `{ token: "" }`.
Expected: 400 (`min(1)` violated).

---

### 3.5 Failure & recovery

**TC-060 / Snapshot rebuild fails after successful accept**
Area: failure · Criticality: High · Traces to: `applyAccept`'s try/catch around `getOrBuild`
Preconditions: force `SnapshotService.getOrBuild` to throw (e.g. Redis/DB error) after the
transaction has already committed.
Input: accept as normal.
Expected: 200 response still returned (the DB transaction — membership, role, `status=accepted` —
already committed and is not rolled back by this failure); `snapshot` and `snapshot_signature` are
`null` in the response; client is expected to fall back to `refetchUser()`/bootstrap per the code
comment. Verify: no 500 is thrown to the client for a post-commit best-effort failure.

**TC-061 / Redis down during checkIpLimit**
Area: failure · Criticality: Medium · Traces to: rate-limit degrade-not-fail-open design
Preconditions: Redis unreachable.
Input: any accept/reject call.
Expected: rate limiter falls back to the DB COUNT path per its documented behavior — request still
proceeds/enforces correctly, never "fails open" silently and never 500s solely due to Redis being
down.

**TC-062 / Retried accept after client timeout (network flake, same token)**
Area: failure / recovery · Criticality: Critical · Traces to: BR-11 idempotency
Preconditions: first accept call's response is lost to the client (timeout) but the transaction
actually committed server-side.
Input: client retries the identical `POST /invitations/accept { token: T }`.
Expected: second call finds `status='accepted'` already → 409 `INVITATION_NOT_PENDING`. Note: this
means a naive client retry-on-timeout will surface a conflict error even though the original action
succeeded — client-side UX should treat `INVITATION_NOT_PENDING` on a retry as "check current state"
rather than a hard failure. Flag as Open Question Q6 (should the API instead return 200 idempotently
for the same user replaying their own successful accept?).

**TC-063 / DB unique-violation race on create (both pre-check and index racing)**
Area: failure / concurrency · Criticality: High · Traces to: BR-4, `rethrowUniqueViolationAs`
Preconditions: two create requests for the exact same (store, role, phone) fire essentially
simultaneously, both passing the pre-check (`findPendingInvite`) before either commits.
Input: two concurrent `POST /stores/S/invitations` with identical role/phone.
Expected: `lockStore` serializes them (both take the row lock in turn), so in practice the second
transaction re-evaluates `expireStalePending`+insert after the first commits; if somehow the unique
constraint is still hit (e.g. between differing code paths), `rethrowUniqueViolationAs` converts the
raw Postgres unique-violation into 409 `INVITATION_ALREADY_PENDING` rather than a raw 500. Exactly
one invite exists afterward.

**TC-064 / Audit log write fails mid-transaction**
Area: failure · Criticality: Medium
Preconditions: `audit.logInTransaction` throws (e.g. constraint violation in audit table).
Expected: entire `create()`/`applyAccept()` transaction rolls back (audit call is inside the same
`tx`) — no orphaned invitation/role/membership row without its audit trail. Verify this atomicity
explicitly, since audit failures are easy to overlook.

**TC-065 / grantMembershipAndRole partially fails (role bump throws)**
Area: failure · Criticality: High
Preconditions: `rbac.bumpPermissionsVersionForRole` throws inside the transaction.
Expected: whole transaction rolls back — invitation stays `pending` (the `markAccepted` UPDATE is
rolled back too, since it's in the same `tx`), no membership row persists, so a subsequent retry can
cleanly re-attempt accept from the true pending state (not stuck half-applied).

---

### 3.6 Concurrency

**TC-070 / Two devices accept the same token simultaneously**
Area: concurrency · Criticality: Critical · Traces to: BR-10, §5 "concurrent identical"
Preconditions: same invite, same user logged in on two devices (or token somehow shared with a
second party), both fire `accept` within milliseconds.
Input: two concurrent `POST /invitations/accept { token: T }`.
Expected: exactly one succeeds (200 with membership/role granted once); the other gets 409
`INVITATION_NOT_PENDING`; final DB state has exactly one `user_role_mappings` row for (winner, R1,
S) — no duplicate role rows, no double audit entries for the grant.

**TC-071 / Accept and reject race on the same token**
Area: concurrency · Criticality: Critical · Traces to: BR-10
Input: `POST /invitations/accept {token:T}` and `POST /invitations/reject {token:T}` fired
concurrently.
Expected: exactly one of {accepted, revoked} is the final state (whichever CAS wins); the loser gets
409 `INVITATION_NOT_PENDING`; if accept wins, membership/role granted; if reject wins, nothing
granted and a subsequent accept attempt also 409s.

**TC-072 / Two concurrent creates for the same store+role+contact (both pass the pre-check)**
Area: concurrency · Criticality: High · Traces to: BR-4
See TC-063 — same scenario from the concurrency angle: verify `lockStore`'s `SELECT ... FOR UPDATE`
actually serializes rather than merely reduces the race window. Expected: exactly one invite row
ends up `pending`; the other request either 409s (if it re-checks after acquiring the lock and finds
a live pending row) or succeeds only if the first was somehow not live (shouldn't happen given the
lock ordering) — the key assertion is **never two live pending rows** for the same triple.

**TC-073 / Concurrent accept while an admin (hypothetically) revokes the role directly**
Area: concurrency · Criticality: Medium · Traces to: cross-module race (role.repository.revokeAssignment)
Preconditions: user's accept transaction is mid-flight (`insertAssignmentIfAbsent` about to run);
concurrently, a store admin uses the (separate) role-management flow to revoke assignments for role
R1 in store S.
Expected: whichever commits last determines final `revokedAt` state for the row — verify this isn't
a lost-update in either direction beyond what's inherent to two independent legitimate writes to the
same row; at minimum, no crash/500 and no duplicate row (the `(userFk, roleFk, storeFk)` unique key
prevents a duplicate).

**TC-074 / Double-submit create from an impatient double-click**
Area: concurrency / UX · Criticality: Medium · Traces to: §5 "duplicate submission"
Input: same create payload submitted twice within the same second (typical double-tap).
Expected: first succeeds (201); second hits the pre-check or the unique index → 409
`INVITATION_ALREADY_PENDING` (client should treat this as "already sent," not a hard error, in its
UX — but the API contract itself is correct/safe).

**TC-075 / Two different contacts race for the "last" custom role assignment slot (if a plan limits staff count)**
Area: concurrency · Criticality: Medium · Traces to: cross-cutting subscription/seat limits (if any
exist upstream of this module — not enforced inside invitation code itself)
Note: this module itself has **no seat/staff-count limit check** on invite creation or acceptance —
any such limit (if it exists on the subscription/plan side) is not visible in this code path at all.
Flag as Open Question Q7: should accepting an invite be blocked if the account/store is already at
its staff-seat limit?

**TC-076 / listMyInvitations called concurrently with an accept that changes the result set**
Area: concurrency / consistency · Criticality: Low
Preconditions: user calls `GET /me/invitations` at the same instant another of their sessions is
mid-`accept` on one of the listed invites.
Expected: no crash; the list reflects whatever was committed at read time (read-committed isolation)
— eventually consistent across the two calls, not a hard requirement for atomic snapshotting here.

---

### 3.7 Permissions / roles

**TC-080 / Actor without Invitation.create permission**
Area: permission · Criticality: Critical · Traces to: `PermissionsGuard` + `RequirePermissions`
Preconditions: staff member in store S with a role that lacks `Invitation.create`.
Input: `POST /stores/S/invitations`.
Expected: 403 (permission guard rejects before the controller body runs); no row created.

**TC-081 / Actor from a different store attempts to invite into store S**
Area: permission / tenancy · Criticality: Critical · Traces to: `TenantGuard`
Preconditions: actor has no accessible-store relationship to S at all.
Input: `POST /stores/S/invitations`.
Expected: 404 `STORE_NOT_ACCESSIBLE` (TenantGuard's deliberately-identical "missing vs inaccessible"
response) — not 403, per the guard's documented timing-oracle-safe contract.

**TC-082 / Actor's permission is revoked mid-session (permission removed after login, before this call)**
Area: permission · Criticality: High · Traces to: §5 "permission change mid-flow"
Preconditions: actor logged in while holding `Invitation.create`; admin revokes that permission from
their role; actor's session/permission cache has not yet refreshed.
Input: `POST /stores/S/invitations` using the stale session.
Expected: depends on `PermissionsGuard`'s cache TTL/versioning — if it checks a live/cached
permissions-version, a stale cache could let one more request through before the version bump is
observed; verify against the actual `PermissionsGuard`/`permissionsVersion` mechanism (out of this
module, but the invite-create endpoint is the surface being tested) — expected end state: no create
succeeds once the version bump has propagated.

**TC-083 / Invitee is not yet an account holder at all (brand-new phone, never signed up)**
Area: permission / first-run · Criticality: High · Traces to: A3
Preconditions: invite created for a phone with no `users` row yet.
Input: the phone owner completes signup/login (creating a `users` row with that phone) then
navigates to accept via the token link.
Expected: token-based accept works exactly as TC-004 regardless of account age — `accept()` only
needs `userId` (the now-logged-in caller) and the token; there is no dependency on the invited
contact having pre-existed as a user at invite-creation time.

**TC-084 / Invitee's account is suspended/locked (users.status) at accept time**
Area: permission / state · Criticality: High · Traces to: cross-module — `users.status` enum
Preconditions: invitee's `users.status = 'suspended'` or `'locked'`.
Input: attempt to call `accept`/`acceptById` while authenticated (if `MobileJwtGuard` even allows a
suspended user's token to pass — depends on guard internals, tested more thoroughly in the auth
module's own suite). Expected here: verify whether this module adds any additional block itself —
inspection shows it does **not**; any gating for suspended/locked users happens entirely in
`MobileJwtGuard`, not in `InvitationService`. Document as: this module trusts the JWT guard fully and
performs no independent user-status check.

**TC-085 / Cross-tenant contact match — same phone number invited by two unrelated stores**
Area: permission / tenancy · Criticality: High · Traces to: BR-4 scope (per store+role, not global)
Preconditions: phone `+91...999` has a live pending invite from store S1 (role R1) and a separate
live pending invite from unrelated store S2 (role R7).
Input: `GET /me/invitations` for the user owning that phone, then accept one.
Expected: both appear in the list (correctly, since the user could legitimately work at two
unrelated stores); accepting the S1 invite must not affect or resolve the S2 invite at all — full
independence confirmed by each invite having its own row/CAS.

---

### 3.8 State transitions

| # | From | Action | To | Expected |
|---|---|---|---|---|
| TC-090 | pending | accept (valid, unexpired) | accepted | legal — TC-004 |
| TC-091 | pending | reject | revoked | legal — TC-006 |
| TC-092 | pending | (implicit, via a later create() for same triple, after TTL lapsed) | expired | legal — TC-021 |
| TC-093 | accepted | accept again (replay) | — | illegal — 409, no transition — TC-026 |
| TC-094 | accepted | reject | — | illegal — 409 `INVITATION_NOT_PENDING`, must verify explicitly (not directly covered above) |
| TC-095 | revoked | accept | — | illegal — 409 — TC-025 |
| TC-096 | revoked | reject again | — | illegal — 409, no double-revoke side effects |
| TC-097 | expired (status literally set) | accept | — | illegal — since `expireStalePending` only ever sets `status='expired'` on rows that are also already time-lapsed, this is really the same as TC-024's runtime check but now the status column also agrees — confirm 403 `INVITATION_EXPIRED` still fires appropriately (not accidentally 409 from a status check ordering bug — code checks `status !== 'pending'` first, so an `expired`-status row actually returns 409 `INVITATION_NOT_PENDING`, **not** 403 `INVITATION_EXPIRED`). This is a subtle but real distinction: **the 403 EXPIRED code path is only reachable while status is still literally 'pending' but time has lapsed** (TC-024); once something has written `status='expired'`, the same accept attempt instead yields 409. Document as intentional-but-worth-confirming (Open Question Q8). |

**TC-098 / Explicit: reject an already-accepted invitation (TC-094 concretely)**
Area: state · Criticality: High
Preconditions: invite accepted (TC-004).
Input: `POST /invitations/reject { token: T }`.
Expected: 409 `INVITATION_NOT_PENDING`; role/membership already granted remain untouched (reject
never un-grants anything even on an error path).

---

### 3.9 Cross-cutting (tenancy, time, offline-sync analog, consistency)

**TC-070 (cross-cutting, distinct from concurrency TC-070 above — renumber note: see §6 for dedup) /
Accept succeeds against a store that was locked (downgrade) after the invite was created**
Area: offline-sync / state / cross-cutting · Criticality: **Critical** · Traces to: BR-13
Preconditions: invite created while store S was in good standing; subsequently S's subscription
downgrades and `stores.locked = true, lockedReason = 'downgrade'`.
Input: invitee accepts the (still pending, unexpired) invite via token or id.
Expected (per current code): 200 success — membership + role granted normally, because the
accept/reject controllers carry no `TenantGuard`/`SubscriptionStatusGuard`/lock check at all. The
new staff member is now a full member with a role in a locked store. Follow-up: any subsequent
*write* action they attempt against store S is correctly blocked with 403 `STORE_LOCKED` by
`SubscriptionStatusGuard` on those other endpoints (reads still work). Net effect: the invite
acceptance itself is not gated by store lock state — confirm with product whether this is intended
(Open Question Q9).

**TC-100 / Accept succeeds against a soft-deleted store**
Area: cross-cutting / state · Criticality: **Critical** · Traces to: BR-13, tenancy
Preconditions: invite created for store S; S is later soft-deleted (`stores.deletedAt` set).
Input: invitee accepts the still-pending, unexpired invite.
Expected (per current code): `findByToken`/`findByIdForContact`/`ensureAccountMembership`/
`insertAssignmentIfAbsent` all query `invitations`/`stores`/`userRoleMappings` directly by
`storeFk`/`accountFk` with **no `deletedAt` filter** — the accept call succeeds (200), a role
mapping is created scoped to a deleted store. The very next request the new member makes that is
store-scoped (anything behind `TenantGuard`) will 404 `STORE_NOT_ACCESSIBLE`, because
`resolveAccessibleStore` filters `isNull(stores.deletedAt)` and `userStoreIds`/accessible-store
resolution will not include a deleted store. Net result: the accept call reports success and mutates
data for a store the user can never subsequently access. Flag to dev as a real gap — accept should
arguably re-check the store is live (not soft-deleted) before granting anything. See Open Question
Q10.

**TC-101 / Accept while the account's subscription has fully lapsed (status='expired')**
Area: cross-cutting · Criticality: High · Traces to: BR-13
Preconditions: account's subscription status is `expired` (definitively inactive,
`PAYMENT_REQUIRED_STATUSES`).
Input: invitee accepts a still-pending, unexpired invite for a store under that account.
Expected: 200 success (same reasoning as TC-070/TC-100 — the accept endpoints don't run
`SubscriptionStatusGuard` at all). The new member is added to an account that can't do any writes
anywhere until the subscription is restored. Confirm this is intended (likely acceptable — reads
should work, and the membership itself isn't a "write against store data" in the billing sense — but
it should be an explicit product decision, not an accidental guard gap). Open Question Q9 covers
this too.

**TC-102 / Timezone — expiresAt stored/compared in UTC regardless of inviter/invitee locale**
Area: cross-cutting / time · Criticality: Medium · Traces to: BR-7
Preconditions: inviter in UTC+9, invitee in UTC-8.
Input: create at inviter's local "9:00 AM" and accept near the 7-day mark from invitee's local
clock.
Expected: `expiresAt` is a `timestamp with time zone` computed server-side from `Date.now()` (UTC
epoch) — client locale is irrelevant; the boundary is a single absolute instant. Verify the mobile
client renders `expires_at` (ISO 8601 with offset) correctly in the invitee's local time on
`GET /me/invitations` (display-only concern, but worth an explicit UX check).

**TC-103 / Server clock skew — invite created with a clock later found to be off**
Area: cross-cutting / time · Criticality: Low
Note: `expiresAt` is computed once at create time from `Date.now()`; if the server's clock is
skewed, the stored `expiresAt` is simply skewed by the same amount — no additional cross-check
against another time source exists. Document as: expiry precision is only as good as the app
server's system clock; no NTP-drift mitigation in this code.

**TC-104 / RBAC cache / permission snapshot consistency after accept**
Area: cross-cutting / consistency · Criticality: High · Traces to: `applyAccept`'s invalidate-then-
rebuild ordering
Preconditions: user's permission snapshot and user-store-id cache are warm (cached) from a prior
session before accepting.
Input: accept a new invite.
Expected: `rbac.invalidateUserStoreCache` and `snapshot.invalidate` both run **before**
`snapshot.getOrBuild`, so the rebuilt snapshot reflects the just-granted membership/role — never a
stale pre-accept snapshot returned in the same response. If snapshot invalidation happened only
after rebuild (a regression to watch for), the response would incorrectly omit the new store —
regression-guard this ordering explicitly in an automated test.

**TC-105 / Two stores' invites both pending, only one has capacity/role deleted mid-flight**
Area: cross-cutting · Criticality: Medium
Preconditions: user has two pending invites (S1/R1, S2/R2); between listing and accepting, S2's
role R2 is soft-deleted by S2's admin.
Input: accept the S2 invite.
Expected: note that `accept`/`acceptById` never re-validate the role's current existence/soft-delete
state (unlike `create()`, which checks `findRoleInStore`) — `applyAccept`/`grantMembershipAndRole`
call `roleRepo.insertAssignmentIfAbsent` directly with `invitation.roleFk`, with no existence check.
Expected result: accept still succeeds and inserts a `user_role_mappings` row pointing at a
soft-deleted role. Flag as a gap — should accepting re-validate the role is still live? Open
Question Q11.

---

### 3.10 UX / experience

**TC-110 / GET /me/invitations — near-expiry invite (expires in <1 hour)**
Area: UX · Criticality: Low
Expected: entry still appears (not filtered until actually past `expiresAt`); client is expected to
render an "expiring soon" affordance from `expires_at` itself — no separate flag from the API for
this; confirm product doesn't expect a dedicated `expiring_soon: boolean` field (Open Question Q12).

**TC-111 / Create response used for delivery — token displayed/copied by inviter UI**
Area: UX · Criticality: Medium · Traces to: A2
Note: delivery (SMS/email send) is explicitly a TODO in the code — until wired, the raw token is
returned directly in the API response. Verify the admin UI does not log this response body anywhere
persistent (analytics, error logs) given it's a live bearer credential for joining the store.

**TC-112 / Reject UX — invitee changes their mind after rejecting**
Area: UX · Criticality: Low
Expected: once rejected, there is no "undo" — the invitee must ask the store admin to send a new
invite, which will succeed (BR-4 satisfied, since the old row is terminal `revoked`, not `pending`).

**TC-113 / Accept response's null snapshot — client fallback path**
Area: UX · Criticality: Medium · Traces to: TC-060
Expected: mobile client, upon receiving `snapshot: null`, correctly triggers its bootstrap/
`refetchUser()` fallback rather than treating `null` as "no permissions" or crashing on a missing
field.

---

## 4. Edge-case scenarios (§5 checklist — called out explicitly)

**E-1 / Reject has no expiry check — accepting vs rejecting an expired invite behave inconsistently**
(TC-027) `assertAcceptable` (used by both accept paths) checks status AND expiry. `reject()` /
`rejectById()` check only status. Concretely: an invite that is technically expired (but still
`status='pending'` because nothing has swept it) **cannot be accepted** (403 EXPIRED) but **can
still be "rejected"** (200, flips to `revoked`). This is a real behavioral inconsistency — decide
with product whether reject should also 403/404 on expiry, or whether "let the invitee tidy up an
expired invite" is fine as-is (harmless since it can't be misused to gain access). → Open Question Q1.

**E-2 / Accepting a new invite for a role the user was previously revoked from does not reactivate the role (Critical)**
(TC-033) `insertAssignmentIfAbsent` is `INSERT ... ON CONFLICT DO NOTHING` against the unique key
`(userFk, roleFk, storeFk)`. If that exact row already exists with `revokedAt` set (from an earlier
unassignment), a brand-new invitation for the same person+role, once accepted, silently fails to
restore access — the invitation is marked `accepted`, an audit log claims the role was granted, but
the actual permission row remains revoked. This is the single highest-value bug candidate found in
this review — recommend an automated regression test and a fix (upsert that clears `revokedAt` and
re-stamps `assignedBy`/`assignedAt` on conflict). → Open Question Q2.

**E-3 / Accept succeeds against a locked (downgrade) store — no lock check on the accept path**
(TC-070 cross-cutting) See BR-13.

**E-4 / Accept succeeds against a soft-deleted store**
(TC-100) See BR-13. Combined with E-3, the general pattern is: **every safety check that exists for
store state (locked, deleted, subscription-lapsed) lives only on the create-invite path's guards
(`TenantGuard`+`SubscriptionStatusGuard`), never on the accept/reject path**, because those
controllers are deliberately store-context-free (by design, since the token itself carries the
store). This is a structural gap worth a deliberate product decision, not just a code nit.

**E-5 / Token-based accept: the logged-in account's contact doesn't match the invited contact at all**
Area: identity edge · Criticality: High · Traces to: A4
Unlike `acceptById` (which explicitly checks `addressedToCaller`), plain `accept(token, userId)`
performs **no contact-match check whatsoever** — the token alone is treated as sufficient proof.
Concretely: if invite `I` was created for `phone: +91...111`, but a completely different logged-in
user `U9` (whose own phone is `+91...999`) somehow obtains the raw token string (e.g. forwarded via
a shared chat, screenshot, "hey check this out"), `U9` can accept it and become a member of store S
with role R1 — **the token is bearer-style identity, deliberately not re-validated against the
holder's own contact**. This is very likely intentional (it's exactly how SMS/email invite links
universally work — whoever holds the link can act on it) but is worth an explicit test + product
sign-off, since it's easy to assume "only the invited phone/email owner can accept" when in fact
"whoever holds the token can accept, as whichever account they're logged into" is the real rule.
→ Open Question Q13. **Test:** create invite for contact A, forward token to logged-in user B (whose
own phone/email differs entirely from A), B calls `POST /invitations/accept`. Expected: 200, B (not
A) becomes the member with the role.

**E-6 / Email case-sensitivity blocks a legitimate accept**
(BR-14) Invite created with `email: "Jane@Example.com"`. Invitee signs up / already has an account
with `users.email = "jane@example.com"` (lowercase, e.g. because their auth provider normalized it).
`acceptById`'s `addressedToCaller` check does exact `===` string comparison → mismatch → 404
`INVITATION_NOT_FOUND`, even though this is obviously "the same person" to any human. The invitee's
only path forward is the *token* link (`accept`, no contact check at all, per E-5) — so the feature
technically still works via the token path, but the in-app `GET /me/invitations` list will never
show this invite to them at all, since `listPendingForContact` also does exact-match `eq()` on
email. **Test:** invite `Jane@Example.com`; user with `jane@example.com` calls `GET /me/invitations`
→ empty list (invite invisible to them) even though a live invite addressed to "them" exists.
→ Open Question Q5/Q14.

**E-7 / Phone format mismatch (with/without country code, spacing, dashes)**
Same mechanism as E-6 but for phone: invite `phone: "+91 98123 45670"` (with spaces) vs. user's
stored `phone: "+919812345670"` (no spaces) — exact-match only, no digit-normalization anywhere.
**Test:** create invite with a differently-formatted-but-semantically-identical phone number than
the invitee's account phone; confirm `GET /me/invitations` doesn't show it and `acceptById` 404s;
only the raw token link works.

**E-8 / First-run — inviting a contact with zero prior relationship to the account/platform**
(TC-083) Confirmed working: invitations aren't validated against existing `users` rows at all at
create time (A3) — this is by design, since inviting someone new to the platform is a first-class
case, not an edge case, in this feature. Included here only to confirm it's explicitly tested, not
assumed.

**E-9 / Many pending invites for one contact across the whole platform (bounded list)**
(TC-047) The `.limit(500)` cap with no `ORDER BY` — technically an edge case per §5 "maximum/
overflow," included for completeness though practically unreachable in normal operation.

**E-10 / Store re-uses a role name/id after the original role was deleted and a same-named role recreated**
Area: edge · Criticality: Low
If role R1 is soft-deleted and a brand-new role R1' (different id, same name "Cashier") is created,
any invite still pointing at the old `roleFk = R1.id` will 404 on accept-time role lookups only if
such a lookup existed — but as established in TC-105/E-4-adjacent, accept **doesn't re-check role
existence** at all, so an invite for a now-deleted role can still be "accepted" and produce a
dangling/soft-deleted-role assignment. Same root cause as TC-105.

**E-11 / Unicode/emoji in contact fields**
Area: edge · Criticality: Low
Email format is constrained by Zod's `.email()` (rejects most garbage), but nothing in this schema
constrains phone to digits/plus — `phone: "☎️+91981234"` would pass the DTO's `max(20)` string check
and be stored verbatim. **Test:** create invite with emoji/unicode-laced phone string; confirm it's
stored and later exact-matched consistently (it will never coincidentally collide with a real
user's phone, so functionally harmless, but worth confirming no encoding/collation surprises in the
unique index comparison).

---

## 5. Coverage summary matrix

| Requirement / Rule / Transition | Satisfied case | Violated / illegal case | Gap? |
|---|---|---|---|
| BR-1 contact required | TC-001/002/003 | TC-011 | — |
| BR-2 role exists/store-scoped/not deleted | TC-001 | TC-013, TC-014 | — |
| BR-3 no system-role invite | TC-001 (custom role) | TC-016, TC-017 | — |
| BR-4 one live pending per contact+role | TC-018 | TC-019, TC-020 (boundary) | — |
| BR-5 stale-pending self-heal | TC-021 | — (no negative form — it's a housekeeping mechanism) | — |
| BR-6 token hashed at rest | TC-022 | — (n/a, invariant not an action) | — |
| BR-7 accept requires pending+unexpired | TC-004, TC-040 | TC-024, TC-025, TC-026, TC-041 | — |
| BR-8 reject requires pending only | TC-006 | TC-098 (reject accepted) | **Yes — E-1, Q1** |
| BR-9 id-accept contact match | TC-005 | TC-029, TC-030 | — |
| BR-10 CAS resolves races | TC-004 | TC-070(concurrency), TC-071 | — |
| BR-11 idempotent grant | TC-004, TC-062 | TC-033 | **Yes — E-2, Q2 (critical bug candidate)** |
| BR-12 no admin cancel/list | — | TC-034 | **Yes — Q3 (product gap)** |
| BR-13 no store-state check on accept | — | TC-070(cross-cutting), TC-100, TC-101 | **Yes — Q9/Q10 (needs product decision)** |
| BR-14 unnormalized contact matching | — | E-6, E-7 | **Yes — Q5/Q14** |
| State: pending→accepted | TC-090 | — | — |
| State: pending→revoked | TC-091 | — | — |
| State: pending→expired | TC-092 | — | — |
| State: accepted→* | — | TC-093, TC-098 | — |
| State: revoked→* | — | TC-095, TC-096 | — |
| State: expired(status)→accept | — | TC-097 | note distinct 409-vs-403 nuance (Q8) |
| Permission: Invitation.create gated | — | TC-080 | — |
| Tenancy: cross-store role/store access | TC-018-class | TC-013, TC-055, TC-081 | — |
| Concurrency: double accept/reject | — | TC-070, TC-071, TC-072 | — |
| Failure recovery: post-commit snapshot failure | TC-060 | — | — |
| Failure recovery: retried accept | TC-062 | — | — (behavior noted as possibly surprising — Q6) |

**Gaps requiring product/dev confirmation before this feature can be called fully specified:**
Q1, Q2 (critical), Q3, Q5, Q6, Q8, Q9, Q10, Q11, Q12, Q13, Q14 — see §7.

---

## 6. Priority roll-up (run first)

**Critical (money/auth/data-integrity/concurrency — run before anything else):**
- TC-033 / E-2 — revoked-role re-accept doesn't restore access (likely a real bug; highest-value
  find in this review).
- TC-026 — replay of an already-accepted token grants nothing extra.
- TC-070 (concurrency) / TC-071 — double-accept / accept-vs-reject races resolve to exactly one
  winner.
- TC-016 / TC-017 — cannot invite as a system role (privilege escalation guard).
- TC-070 (cross-cutting) / TC-100 — accept against a locked/soft-deleted store (confirm intended
  behavior with product, then lock in with a test either way).
- TC-004 / TC-005 — core happy-path grant is atomic and correct.
- TC-029 — id-accept contact mismatch is a hard 404, not a leak.
- E-5 — token-as-bearer-credential semantics (confirm intended, then test explicitly).

**High:**
- TC-019 (duplicate pending invite blocked), TC-021 (stale self-heal), TC-024/TC-040/TC-041 (expiry
  boundary), TC-027 (reject-after-expiry inconsistency), TC-055/TC-081 (tenancy on create), TC-062
  (retried accept semantics), TC-063/TC-072 (create race), TC-065 (partial-failure rollback),
  TC-082 (permission revoked mid-session), TC-104 (cache/snapshot ordering).

**Medium:** boundary/DTO validation cases (TC-042–047, TC-050–058), TC-034 (no cancel endpoint),
TC-073–076 (secondary concurrency), TC-102/103 (timezone/clock), E-6/E-7/E-10/E-11.

**Low:** TC-046/047 (list edge sizes), TC-110–113 (UX polish), E-9.

---

## 7. Open questions (need product/dev confirmation)

1. **Q1:** Should `reject()`/`rejectById()` also reject (404/409) an invite whose `expiresAt` has
   lapsed, for consistency with `accept()`'s `assertAcceptable`? Currently reject has no expiry
   check at all (TC-027, E-1).
2. **Q2 (highest priority):** `insertAssignmentIfAbsent`'s `onConflictDoNothing` means re-accepting
   an invite for a role the user was previously revoked from does not reactivate that role
   (`revokedAt` stays set) — invitation shows `accepted`, audit says granted, but no actual access
   is restored. Is this the intended behavior, or should accept upsert/clear `revokedAt` on
   conflict? (TC-033, E-2.)
3. **Q3:** Is it intentional that store admins have no way to list their store's outstanding
   invitations or cancel/revoke one they sent (e.g., wrong contact typo)? Today the only way to stop
   a pending invite early is for the invitee to reject it. (TC-034.)
4. **Q4:** `listPendingForContact`'s `.limit(500)` has no `ORDER BY` — does determinism of which 500
   (in the practically-unreachable >500 case) matter? (TC-047.)
5. **Q5/Q14:** No phone/email normalization exists anywhere in the backend. Should invite creation
   and/or acceptance normalize (lowercase email, E.164-normalize phone) so that case/format
   differences between what an admin types and what's stored on the invitee's account don't
   silently hide a legitimate invite from `GET /me/invitations` / block `acceptById`? (E-6, E-7,
   TC-057.)
6. **Q6:** Should a retried accept of the caller's *own* already-accepted invitation be idempotent
   (200) instead of 409 `INVITATION_NOT_PENDING`, to be safe under client-side retry-on-timeout?
   Currently any second call — even from the same rightful winner — 409s. (TC-062.)
7. **Q7:** Is there (or should there be) any staff-seat/plan-limit check on invite creation or
   acceptance? None is visible in this module. (TC-075.)
8. **Q8:** Once a stale invite's status has actually been flipped to `'expired'` (via a later
   `create()` sweep), an accept attempt yields 409 `INVITATION_NOT_PENDING` rather than 403
   `INVITATION_EXPIRED` (status-check happens before the expiry-check in `assertAcceptable`, and by
   then status is no longer `'pending'`). Is this distinction ("EXPIRED only reachable transiently
   before anything sweeps status") acceptable, or should an `expired`-status row still surface as
   403 EXPIRED specifically for a clearer client message? (TC-097.)
9. **Q9:** Is it intended that invite acceptance is entirely ungated by store lock / soft-delete /
   subscription status (only invite *creation* is gated)? If a store is locked mid-flight, is
   "let them join, but they can't do anything until unlocked" the desired UX, or should acceptance
   itself be blocked with a clear message? (TC-070 cross-cutting, TC-101, E-3.)
10. **Q10:** Accepting an invite to a store that has since been soft-deleted currently succeeds and
    writes a role mapping the user can never subsequently use (every store-scoped endpoint 404s
    `STORE_NOT_ACCESSIBLE` immediately after). Should accept re-validate the store is live
    (`deletedAt IS NULL`) before granting anything, and return a clear error instead? (TC-100, E-4.)
11. **Q11:** Should `accept`/`acceptById` re-validate that the invited role still exists and isn't
    soft-deleted (the way `create()` does), instead of blindly inserting a mapping to
    `invitation.roleFk`? (TC-105, E-10.)
12. **Q12:** Does the mobile client need a dedicated "expiring soon" signal from the API, or is
    computing it client-side from `expires_at` sufficient? (TC-110.)
13. **Q13:** Confirm explicitly with product that the token-based accept path is *intentionally*
    bearer-style (whoever holds the raw token can redeem it as whichever account they're logged into
    — no re-check against the invited contact), as opposed to an oversight relative to
    `acceptById`'s explicit contact-match check. (E-5.)
14. **Q14:** See Q5 — specifically for `GET /me/invitations` invisibility when the invited contact's
    casing/format differs from the account's stored contact, is silent invisibility (no error, just
    absent from the list) acceptable, or should there be a "claim by verifying contact" recovery
    path?