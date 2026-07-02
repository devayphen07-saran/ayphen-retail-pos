# api-manager — Conventions

> **Scope**: How to define and consume HTTP endpoints in `@ayphen-retail/api-manager`.
> Read this before adding a server call anywhere in the mobile app or web app.
>
> The shared `API` axios instance and the `APIData` registry are the **single
> source of truth** for every endpoint. New endpoints are declared here first,
> then consumed — never hardcoded at the call site.

---

## 1. The model

Every endpoint is one `APIData` instance: a method + a path template + an
optional `public` flag. The instance is the one place that knows the URL, and
it can produce a Redux thunk, a TanStack Query/Mutation config, or be used
directly with the axios instance.

```ts
// api-data.ts
export const ME_BOOTSTRAP = new APIData('me/bootstrap', APIMethod.GET);
export const CREATE_STORE = new APIData('stores', APIMethod.POST);
export const REFRESH      = new APIData('auth/refresh', APIMethod.POST, { public: true });
export const SYNC_CHANGES = new APIData('stores/:storeId/sync/changes', APIMethod.GET);
```

What `APIData` gives you (see [api-handler.ts](src/lib/api-handler.ts)):

- **Path templating** — `:storeId`, `:token` placeholders filled from `pathParam`; throws if a placeholder is left unresolved or an unknown key is passed. Values are URL-encoded.
- **`public: true`** — strips the `Authorization` header (login/signup/refresh/challenge/time).
- **`normalizeError`** — every failure becomes a `NormalizedError` (`{ status, code, message, isOffline, data }`). `isOffline` is set for network/timeout errors — use it to drive offline UX.
- **`RequestParams<T>`** — the universal variable shape: `{ bodyParam?, pathParam?, queryParam? }`. All four consumption modes accept this.
- **Four consumption modes**: `generateAsyncThunk`, `generateAsyncThunkForMultipart`, `queryOptions` (TanStack), `mutationOptions` (TanStack). Plus raw use via `API` + `APIData.path`.

---

## 2. Folder convention — one folder per domain

Each domain is a folder with **four files** following the ayphen-next pattern:

```
src/lib/<domain>/
├── api-data.ts          ← APIData instances (the endpoints)
├── types.ts             ← request + response TypeScript types
├── tanstack-queries.ts  ← query key objects + useQuery / useMutation hooks
└── index.ts             ← export * from the three above
```

Some domains also have:
- `api-thunk.ts` — Redux async thunks (auth only; prefer TanStack for new work)
- `system-roles.ts` — role code constants (auth only)

Then every domain is re-exported from the package barrel (`src/index.ts`).

### Current domains

| Domain | Folder | Endpoints |
|---|---|---|
| Shared types | `common/` | PermissionSnapshot, EntityCrudGrant, SubscriptionSnapshot, … |
| Auth / OTP / Step-up | `auth/` | SIGNUP, LOGIN, REFRESH, LOGOUT, OTP_REQUEST, STEP_UP, MOBILE_CHALLENGE, SERVER_TIME |
| Me / Profile | `me/` | ME_BOOTSTRAP, ME_UPDATE_PROFILE, ME_UPDATE_ACCOUNT_MODE, ME_UPDATE_PREFERENCES, ME_DEVICES |
| Store | `store/` | CREATE_STORE, GET_STORE, UPDATE_STORE |
| Invitations | `invitation/` | SEND_INVITATION, GET_STORE_INVITATIONS, REVOKE_INVITATION, GET_INVITATION_PREVIEW, ACCEPT_INVITATION*, DECLINE_INVITATION* |
| Lookups | `lookup/` | GET_LOOKUP_TYPES, GET_GLOBAL_LOOKUPS, GET_UNITS, GET_STATES, GET_CURRENCIES, GET/CREATE/UPDATE/DELETE_STORE_LOOKUP |
| RBAC | `rbac/` | GET/CREATE/UPDATE/DELETE_STORE_ROLE, GET/SAVE_ROLE_PERMISSIONS, GET_ROLE_MEMBERS, REVOKE_ASSIGNMENT, GET_RBAC_ENTITY_TYPES |
| Subscription | `subscription/` | GET_SUBSCRIPTION_PLANS, GET_SUBSCRIPTION_PLAN_BY_CODE, CREATE_CHECKOUT, VERIFY_PAYMENT |
| Sync | `sync/` | SYNC_INITIAL, SYNC_CHANGES, SYNC_DELTA, RESOLVE_SYNC_CONFLICT |
| Notes | `notes/` | GET/CREATE/UPDATE/DELETE_RECORD_NOTE |
| Address | `address/` | GET/CREATE/UPDATE/DELETE_RECORD_ADDRESS |

---

## 3. `tanstack-queries.ts` — the hook file

Every domain with screen-level reads or user-triggered mutations owns a
`tanstack-queries.ts` that has three sections:

### 3a. Query keys

A typed key factory so every invalidation is safe and refactorable:

```ts
export const storeKeys = {
  all: ['stores'] as const,
  detail: (storeId: string) => [...storeKeys.all, storeId] as const,
};
```

### 3b. Query hooks (GET endpoints)

Wrap `APIData.queryOptions()` and override `queryKey` with the factory key. Pass
`options?.enabled` to let call sites gate the fetch:

```ts
export const useGetStoreQuery = (storeId: string, options?: { enabled?: boolean }) => {
  return useQuery({
    ...GET_STORE.queryOptions<StoreProfileResponse>({ pathParam: { storeId } }),
    queryKey: storeKeys.detail(storeId),
    enabled: options?.enabled ?? !!storeId,
  });
};
```

### 3c. Mutation hooks (POST / PATCH / PUT / DELETE)

Wrap `APIData.mutationOptions()`. The mutation variable is always
`RequestParams<TBody>`:

```ts
// At the hook definition
export const useUpdateStoreMutation = (storeId: string) => {
  const queryClient = useQueryClient();
  return useMutation(
    UPDATE_STORE.mutationOptions<StoreProfileResponse, UpdateStoreRequest>({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: storeKeys.detail(storeId) });
      },
    }),
  );
};

// At the call site — body-only mutation
await updateStore.mutateAsync({ bodyParam: { name: 'New Name' } });

// At the call site — path params + body
await updateStore.mutateAsync({
  pathParam: { storeId: '123' },
  bodyParam: { name: 'New Name' },
});
```

---

## 4. Which consumption mode — and the offline-first rule

Retail is offline-first. That changes the usual "everything is a thunk" answer.
Pick the mode by **what kind of call it is**:

| Call kind | Mode | Why |
|---|---|---|
| **Entity write** (product, order, customer create/update/delete) | **None — use the sync queue** | Writes go through `applyOptimistic` / the mutation queue, **never** `api-manager`. The sync engine owns the server round-trip. |
| **Sync engine endpoints** (`/sync/initial`, `/sync/changes`, `/sync/delta`) | **Raw `API` + `APIData.path`** | The engine needs custom timeouts, sync-session headers, and transaction control. Keep raw — but reference `.path`, never a hardcoded string. |
| **Server reads for a screen** (bootstrap, invitation preview, lookups, reference data) | **`queryOptions()` + `useQuery`** | Gets caching, cancellation (AbortSignal forwarded to axios), and offline-fallback for free. |
| **One-off non-entity mutations** (accept/decline invite, `PATCH /me*`, account-mode) | **`mutationOptions()` + `useMutation`** | Not synced entities — react-query mutation is the correct home. |
| **File upload** | **`generateAsyncThunkForMultipart`** or raw multipart | Builds `FormData` and sets the content-type header. |
| **Auth bootstrap plumbing** (refresh, logout, device challenge) | **Raw `API` + `.path`** in `authThunks`/interceptors | Run outside react-query, in the session lifecycle. Already correct. |

**The Redux `generateAsyncThunk` path is currently unused in mobile** — the
thunks in `auth/api-thunk.ts` (`login`, `signup`, …) have no dispatch sites.
Prefer `queryOptions`/`mutationOptions` for new screen-level calls; only add a
thunk if a call genuinely belongs in Redux (it usually doesn't).

### The one hard rule

> **Never hardcode a URL string at a call site.** Reference the `APIData`
> instance — `SYNC_CHANGES.path`, or its `queryOptions()`/`mutationOptions()`.
> If the endpoint isn't in the registry yet, add it there first.

```ts
// ✅ query for a screen
const { data } = useQuery({
  ...GET_INVITATION_PREVIEW.queryOptions<InvitationPreviewResponse>({ pathParam: { token } }),
  queryKey: invitationKeys.preview(token),
  enabled: !!token,
});

// ✅ mutation with path + body
const mutation = useUpdateStoreMutation(storeId);
await mutation.mutateAsync({ pathParam: { storeId }, bodyParam: { name } });

// ✅ engine-internal raw call — path from the registry
const res = await API.get<SyncChangesEnvelope>(
  SYNC_CHANGES.path.replace(':storeId', storeId),
  { params, headers: { 'x-sync-session-id': sessionId }, timeout: PULL_TIMEOUT_MS },
);

// ❌ never hardcode
const res = await API.get(`/stores/${storeId}/sync/changes`);
```

---

## 5. Adding a new endpoint — checklist

1. **`<domain>/api-data.ts`** — add the `APIData` instance. Write a JSDoc line describing the route and any path params. Mark `public: true` if no auth header is needed.
2. **`<domain>/types.ts`** — add the request and response interfaces. Mirror the wire shape (snake_case for backend fields).
3. **`<domain>/tanstack-queries.ts`** — add the query key entry + `useXxxQuery`/`useXxxMutation` hook.
4. **`<domain>/index.ts`** — already exports `* from './tanstack-queries'`; no change needed.
5. **`src/index.ts`** — already re-exports all domains; no change needed unless it's a brand new domain folder.
6. If it's an **entity write**, stop — it belongs in the sync queue, not here.

---

## 6. Adding a brand new domain

```
src/lib/<domain>/
├── api-data.ts
├── types.ts
├── tanstack-queries.ts
└── index.ts            ← export * from './api-data'; export * from './types'; export * from './tanstack-queries';
```

Then add one line to `src/index.ts`:

```ts
export * from './lib/<domain>';
```

---

## 7. Current drift — migration audit (opportunistic)

13 raw `API.*` call sites today. Classification, so future edits know what to fix vs leave:

| Call site | Verdict |
|---|---|
| `core/sync/sync-pull.ts` (`/sync/initial`, `/sync/changes`), `sync-push.ts` (`/sync/delta`) | **Keep raw** (engine-internal). Cleanup: build the path from `SYNC_*` `.path` instead of template-literal strings. |
| `core/store/authThunks.ts` (`REFRESH.path`, `LOGOUT.path`, challenge) | **Keep raw** — already references registry `.path`. Good. |
| `core/network/server-clock.ts` (`SERVER_TIME.path`) | **Keep raw** — already references `.path`. Good. |
| `features/invitations/hooks/useAcceptInvitation.ts`, `useDeclineInvitation.ts` | **Migrate** to `ACCEPT_INVITATION.mutationOptions()` when next touched. |
| `features/sync-issues/hooks/useSyncIssues.ts` (conflict `PATCH`) | **Migrate** to `RESOLVE_SYNC_CONFLICT.mutationOptions()`, or at least use its `.path`. |

> This audit is a guide for *opportunistic* migration — fix a row when you're
> already editing that file. No big-bang rewrite.
