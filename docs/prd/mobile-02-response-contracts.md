# Mobile Architecture · Part 2 — Corrected Response Contracts

> Part of the [Mobile Post-Login & Freshness](./MOBILE_POST_LOGIN_AND_FRESHNESS.md) series.

---

## 3. Corrected response contracts

### Cross-cutting
- **Remove `server_time` from every response body** — it's on every response as the
  `x-server-time` header.
- **Unify the snapshot type** — `PermissionSnapshot` in refresh but
  `Record<string, unknown>` in `sync-delta.dto.ts`. Make both `PermissionSnapshot`.

### 3a. `/auth/login` → `LoginTokenResponseDto`
| Field | Verdict |
|---|---|
| `access_token`, `refresh_token` | KEEP |
| `is_new_user` | KEEP (analytics/welcome only — do NOT route off it) |
| `user{}` (full) | SLIM to `id` + `permissions_version`; bootstrap owns the rest (it re-returns a superset ms later) |
| `server_time` | REMOVE (header) |

### 3b. `/auth/refresh` → `RefreshResponseDto`
| Field | Verdict |
|---|---|
| `access_token`, `refresh_token` | KEEP |
| `snapshot` + `snapshot_signature` | KEEP — inline when changed, null when not (right pattern) |
| `snapshot_changed` | KEEP |
| `force_bootstrap` (= `snapshotChanged` today) | **FIX** — over-triggers. The new snapshot is already inline; only force a bootstrap for things the snapshot can't carry (schema_version bump). For pure permission changes keep it `false`. |
| `store_access_changed` (= `snapshotChanged` today) | **FIX** — fires on any pv bump even when the store set is identical. Compute by diffing `snapshot.stores[].store_id` vs the client's prior set. |
| `server_time` | REMOVE (header) |

### 3c. `/me/bootstrap` → `BootstrapResponseDto`
**KEEP:** `user` core, `profile_status`/`missing_fields`, `snapshot`(+sig+pv), `preferences`.
**SHIPPED ✅:** `has_pending_invitations: boolean` and `active_store: { id, guuid } | null` are
already present in `BootstrapResponseDto` (verified: api-reference §2). The backend resolves
`active_store` via `last_opened ?? default ?? (single→that / multiple→null=picker)`. The client
re-resolves only when the returned active store becomes invalid (§8B.4).
| Remove from bootstrap | Where it should live | Why |
|---|---|---|
| `store_logos` | lazy per active store; logo attachment-id on synced `store` entity | N+1 signed-URL generation every open (`bootstrap.service.ts:376-390`) |
| `store_hours` | sync (store-scoped) or `GET /stores/:id/hours` | active-store-scoped → forces re-bootstrap on store switch |
| `pending_invitations[]` | `GET /me/invitations` (on demand) | joined every open for the ~99% with none |
| `sync_config` | bake into app build / cache by `schema_version` | static AND wrong (12 entities listed; real registry ~21; `tax_rate` vs registered `taxrate`) |
| `app_config` | public `GET /auth/mobile/app-version` | hardcoded; maintenance/version must be checkable pre-auth |
| `subscription` (top-level) | `snapshot.stores[active].subscription` | exact duplicate |
| `server_time` | `x-server-time` header | duplicate |

**Conditional fetch:** bootstrap should honor `If-None-Match`/ETag keyed on
`(permissions_version + preferences hash)` → return `304` when unchanged
(`/me/pv` already emits an ETag: `me.controller.ts:45`).

### 3d. `/sync/initial` → `SyncInitialEnvelope`
Shape is correct: `entity_type, upserts[], has_more, page_cursor,
all_entities_complete, remaining_entity_types[], next_delta_cursor, estimated_total?`.
- REMOVE `server_time` (header).
- **Protocol fix:** one-entity-per-call across ~21 types × pages is too chatty.
  Batch small reference entities (`unit`, `lookup`, `payment_method`, `taxrate`,
  `store`) into one page; keep big ones (`product`, `customer`, `order`) solo.

### 3e. `/sync/changes` → `SyncChangesEnvelope`
`changes{entity:{upserts,deletes}}, sync_cursor, has_more`. Correct.
- Tombstone `deleted_by_user_fk` + `deleted_by_display_name` ship on every delete;
  pure sync only needs `guuid` + `hard_delete`. **Move "who deleted" to an activity
  endpoint.**
- REMOVE `server_time` (header).

### 3f. `/sync/delta` → `SyncDeltaResponseDto`
`mutation_results[] (applied|duplicate|rejected|conflict), changes, sync_cursor,
has_more, snapshot?, snapshot_signature?, permissions_version?`. Best-designed of the
four (push + pull + snapshot piggyback in one round trip).
- REMOVE `server_time` (header). Unify snapshot type (see cross-cutting).

**Actual bootstrap shape (verified ✅ — api-reference §2):**
```
{ user{core}, profile_status, missing_fields,
  snapshot, snapshot_signature, permissions_version,
  preferences, has_pending_invitations,           // ✅ present
  active_store: { id, guuid } | null,             // ✅ present
  active_store_access: { status:'granted', is_new_slot }
    | { status:'limit_reached', device_limit, active_device_count } | null }
```
