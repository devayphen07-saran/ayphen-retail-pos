# Table Architecture — Ayphen Retail POS (every table, every column)

> **App:** Ayphen Retail POS (`apps/backend` — NestJS · Drizzle · PostgreSQL · Redis · offline-first)
> **Source of truth:** `apps/backend/src/db/schema.ts` (26 tables today) + planned additions.
> **Status:** ✅ exists · ➕ add now · 🕐 add with paid tiers.

## Conventions
- `id` `uuid` PK (`defaultRandom`) — internal, FK target. `guuid` `uuid` unique — public id (only `users`).
- FKs are `uuid` → target `id`. Money = `bigint` **paise**. Status = `text` enum (never a `status_fk`).
- **`auditColumns`** expands to: `created_at`, `updated_at`, `deleted_at`, `created_by` (uuid), `updated_by` (uuid), `deleted_by` (uuid).
- All `timestamp` are `timestamptz` (`with time zone`). "PK/FK/U/NN" = primary key / foreign key / unique / not-null.

---

## 1. `users` ✅
| Column | Type | Constraints / Notes |
|---|---|---|
| id | uuid | PK, default random |
| guuid | uuid | NN, default random — public id |
| email | text | unique, nullable |
| phone | text | unique, nullable (CHECK: email OR phone NN) |
| name | text | NN |
| email_verified | boolean | NN, default false |
| phone_verified | boolean | NN, default false |
| primary_login_method | text enum | NN, default `otp` — `otp`·`password`·`google` |
| permissions_version | integer | NN, default 1 — RBAC cache-bust |
| status | text enum | NN, default `active` — `active`·`suspended`·`locked` |
| last_account_mode | text enum | nullable — `business`·`personal` |
| is_blocked | boolean | NN, default false |
| blocked_reason | text | nullable |
| failed_login_attempts | integer | NN, default 0 |
| account_locked_until | timestamptz | nullable |
| mfa_enabled | boolean | NN, default false |
| password_changed_at | timestamptz | nullable |
| last_login_at | timestamptz | nullable |
| image_attachment_fk | uuid | nullable |
| deleted_at | timestamptz | nullable (null = active) |
| created_at | timestamptz | NN, default now |
| updated_at | timestamptz | NN, default now |

---

## 2. `accounts` ✅
| Column | Type | Constraints / Notes |
|---|---|---|
| id | uuid | PK |
| account_number | text | NN, unique |
| name | text | NN |
| owner_user_fk | uuid | FK → users.id, nullable — account authority = ownership |
| gst_number | text | nullable |
| billing_address | jsonb | nullable |
| razorpay_customer_id | text | nullable |
| created_at | timestamptz | NN, default now |
| updated_at | timestamptz | NN, default now |

## 3. `account_users` ✅
| Column | Type | Constraints / Notes |
|---|---|---|
| id | uuid | PK |
| account_fk | uuid | FK → accounts.id (cascade), NN |
| user_fk | uuid | FK → users.id (cascade), NN |
| created_at | timestamptz | NN, default now |

Unique `(account_fk, user_fk)`; index `(user_fk)`.

## 4. `stores` ✅
| Column | Type | Constraints / Notes |
|---|---|---|
| id | uuid | PK |
| account_fk | uuid | FK → accounts.id, NN |
| name | text | NN |
| gst_number | text | nullable |
| address | text | nullable |
| phone | text | nullable |
| email | text | nullable |
| invoice_prefix | text | NN, default `INV` |
| invoice_counter | integer | NN, default 0 |
| is_active | boolean | NN, default true |
| locked | boolean | NN, default false |
| created_at | timestamptz | NN, default now *(auditColumns)* |
| updated_at | timestamptz | NN, default now |
| deleted_at | timestamptz | nullable |
| created_by | uuid | nullable |
| updated_by | uuid | nullable |
| deleted_by | uuid | nullable |

Index `(account_fk)`.

## 5. `locations` ✅
| Column | Type | Constraints / Notes |
|---|---|---|
| id | uuid | PK |
| store_fk | uuid | FK → stores.id (cascade), NN |
| name | text | NN |
| is_primary | boolean | NN, default false — Head Office |
| is_default | boolean | NN, default false — device opens into |
| enable | boolean | NN, default true |
| is_active | boolean | NN, default true — soft-delete |
| display_order | integer | NN, default 0 |
| locked | boolean | NN, default false — downgrade-locked |
| archived_at | timestamptz | nullable |
| created_at | timestamptz | NN, default now |
| updated_at | timestamptz | NN, default now |

Partial-unique one primary per store; partial-unique one default per store; partial index on active.

## 6. `user_location_mappings` ✅
| Column | Type | Constraints / Notes |
|---|---|---|
| id | uuid | PK |
| user_fk | uuid | FK → users.id (cascade), NN |
| location_fk | uuid | FK → locations.id (cascade), NN |
| assigned_by | uuid | FK → users.id, nullable |
| assigned_at | timestamptz | NN, default now |
| revoked_at | timestamptz | nullable (null = active) |

Unique `(user_fk, location_fk)`; indexes `(user_fk, revoked_at)`, `(location_fk)`.

---

## 7. `roles` ✅
| Column | Type | Constraints / Notes |
|---|---|---|
| id | uuid | PK — *(no `guuid`; roles referenced by id)* |
| store_fk | uuid | FK → stores.id, nullable — null = system-wide role |
| code | text | NN — `STORE_OWNER`, `CASHIER`… |
| name | text | NN |
| description | text | nullable |
| is_editable | boolean | NN, default true — false for system roles |
| created_at | timestamptz | NN, default now *(auditColumns)* |
| updated_at | timestamptz | NN, default now |
| deleted_at | timestamptz | nullable |
| created_by | uuid | nullable |
| updated_by | uuid | nullable |
| deleted_by | uuid | nullable |

CHECK `system_role_no_store`; unique system code where `store_fk IS NULL`; unique `(store_fk, name)`; index `(store_fk)`.

## 8. `role_permissions` ✅
| Column | Type | Constraints / Notes |
|---|---|---|
| id | uuid | PK |
| role_fk | uuid | FK → roles.id, NN |
| entity_code | text | NN — PascalCase (`Order`) |
| action | text enum | NN — `view`·`create`·`edit`·`delete` |
| granted_by | uuid | FK → users.id, nullable |
| granted_at | timestamptz | NN, default now |
| revoked_at | timestamptz | nullable — null = active grant |

Unique `(role_fk, entity_code, action)`; index `(role_fk)`.

## 9. `role_special_permissions` ✅
| Column | Type | Constraints / Notes |
|---|---|---|
| id | uuid | PK |
| role_fk | uuid | FK → roles.id, NN |
| entity_code | text | NN |
| action_code | text | NN — SCREAMING_SNAKE (`REFUND`) |
| granted_by | uuid | FK → users.id, nullable |
| granted_at | timestamptz | NN, default now |
| revoked_at | timestamptz | nullable |

Unique `(role_fk, entity_code, action_code)`; index `(role_fk)`.

## 10. `user_role_mappings` ✅
| Column | Type | Constraints / Notes |
|---|---|---|
| id | uuid | PK |
| user_fk | uuid | FK → users.id, NN |
| role_fk | uuid | FK → roles.id, NN |
| store_fk | uuid | FK → stores.id, nullable — null = system-wide |
| assigned_by | uuid | FK → users.id, nullable |
| assigned_at | timestamptz | NN, default now |
| revoked_at | timestamptz | nullable — soft-delete |
| expires_at | timestamptz | nullable — temporary assignment |

Unique `(user_fk, role_fk, store_fk)`; indexes `(user_fk, store_fk)`, `(role_fk)`.

## 11. `entity_types` ✅ *(🔧 orphaned — wire it)*
| Column | Type | Constraints / Notes |
|---|---|---|
| id | uuid | PK |
| code | text | NN, unique — `Product`, `Order`… |
| label | text | NN |
| is_offline_safe | boolean | NN, default false |
| supports_attachments | boolean | NN, default false |

---

## 12. `invitations` ✅
| Column | Type | Constraints / Notes |
|---|---|---|
| id | uuid | PK |
| store_fk | uuid | FK → stores.id, NN |
| role_fk | uuid | FK → roles.id, NN — custom roles only |
| phone | text | nullable |
| email | text | nullable |
| token | text | NN, unique — opaque accept token |
| status | text enum | NN, default `pending` — `pending`·`accepted`·`revoked`·`expired` |
| invited_by | uuid | FK → users.id, NN |
| accepted_by | uuid | FK → users.id, nullable |
| expires_at | timestamptz | NN |
| accepted_at | timestamptz | nullable |
| created_at | timestamptz | NN, default now |

Indexes `(store_fk)`, `(phone)`, `(status)`. 🔧 nothing sets `expired` yet — add cron.

## 13. `invitation_locations` ➕
| Column | Type | Constraints / Notes |
|---|---|---|
| id | uuid | PK |
| invitation_fk | uuid | FK → invitations.id (cascade), NN |
| location_fk | uuid | FK → locations.id (cascade), nullable — **null = all locations** |
| created_at | timestamptz | NN, default now |

Unique `(invitation_fk, location_fk)`; index `(invitation_fk)`. On accept → one `user_location_mappings` row per branch.

---

## 14. `devices` ✅
| Column | Type | Constraints / Notes |
|---|---|---|
| id | uuid | PK |
| user_fk | uuid | FK → users.id (cascade), NN |
| public_key | text | NN — Ed25519 |
| public_key_hash | text | NN |
| platform | text enum | NN — `ios`·`android`·`web` |
| model | text | nullable |
| os_version | text | nullable |
| app_version | text | nullable |
| attestation_verified | boolean | NN, default false |
| is_trusted | boolean | NN, default false |
| is_blocked | boolean | NN, default false |
| label | text | nullable |
| first_seen_at | timestamptz | NN, default now |
| last_seen_at | timestamptz | NN, default now |
| last_ip | text | nullable |
| push_token | text | nullable |
| last_sync_at | timestamptz | nullable |
| blocked_at | timestamptz | nullable |

Unique `(user_fk, public_key_hash)`.

## 15. `device_sessions` ✅
| Column | Type | Constraints / Notes |
|---|---|---|
| id | uuid | PK |
| user_fk | uuid | FK → users.id, NN |
| device_fk | uuid | FK → devices.id, NN |
| expires_at | timestamptz | NN |
| last_used_at | timestamptz | NN, default now |
| last_step_up_at | timestamptz | nullable |
| last_step_up_method | text enum | nullable — `otp`·`password`·`biometric` |
| step_up_locked_until | timestamptz | nullable |
| revoked_at | timestamptz | nullable |
| revoked_reason | text | nullable |
| current_jti | text | nullable |
| current_jti_exp | timestamptz | nullable |
| ip_at_creation | text | nullable |
| geo_at_creation | text | nullable |
| device_name | text | nullable |
| os | text | nullable |
| app_version | text | nullable |
| platform | text | nullable |
| last_app_version | text | nullable |
| push_token | text | nullable |
| created_at | timestamptz | NN, default now |

Indexes `(user_fk)`, `(device_fk)`.

## 16. `store_device_access` ✅
| Column | Type | Constraints / Notes |
|---|---|---|
| id | uuid | PK |
| store_fk | uuid | FK → stores.id (cascade), NN |
| device_fk | uuid | FK → devices.id (cascade), NN |
| user_fk | uuid | FK → users.id (cascade), NN |
| location_fk | uuid | FK → locations.id, nullable |
| status | text enum | NN, default `active` — `active`·`revoked`·`expired` |
| device_label | text | nullable |
| first_accessed_at | timestamptz | NN, default now |
| last_accessed_at | timestamptz | NN, default now |
| revoked_at | timestamptz | nullable |
| revoked_by | uuid | FK → users.id, nullable |
| revoked_reason | text enum | nullable — `owner_removed`·`stolen`·`auto_expired`·`plan_downgrade`·`released` |
| created_at | timestamptz | NN, default now |
| modified_at | timestamptz | NN, default now |

Partial-unique `(store_fk, device_fk) WHERE status='active'`; indexes `(store_fk)`, `(device_fk)`.

---

## 17. `refresh_tokens` ✅
| Column | Type | Constraints / Notes |
|---|---|---|
| id | uuid | PK |
| device_session_fk | uuid | FK → device_sessions.id, NN |
| token_hash | text | NN, unique — SHA-256 |
| parent_id | uuid | nullable — self-ref rotation chain |
| family_id | uuid | NN — groups a rotation chain |
| issued_at | timestamptz | NN, default now |
| expires_at | timestamptz | NN |
| used_at | timestamptz | nullable — 2nd use = reuse attack |
| revoked_at | timestamptz | nullable |
| revoked_reason | text | nullable |

Unique `(token_hash)`.

## 18. `otp_requests` ✅
| Column | Type | Constraints / Notes |
|---|---|---|
| id | uuid | PK |
| phone | text | NN |
| purpose | text enum | NN — `login`·`signup`·`step_up` |
| attempts | integer | NN, default 0 |
| max_attempts | integer | NN, default 5 |
| consumed_at | timestamptz | nullable |
| expires_at | timestamptz | NN |
| created_at | timestamptz | NN, default now |

Index `(phone)`.

## 19. `revoked_tokens` ✅
| Column | Type | Constraints / Notes |
|---|---|---|
| jti | text | **PK** |
| expires_at | timestamptz | NN |
| created_at | timestamptz | NN, default now |

## 20. `login_attempts` ✅
| Column | Type | Constraints / Notes |
|---|---|---|
| id | uuid | PK |
| ip | text | NN |
| user_id | uuid | nullable |
| email | text | nullable |
| phone | text | nullable |
| purpose | text | NN — `login`·`otp`·`signup` |
| success | boolean | NN, default false |
| created_at | timestamptz | NN, default now |

Indexes `(ip, created_at)`, `(phone, purpose, created_at)`, `(email, created_at)`, `(user_id, created_at)`.

---

## 21. `plans` ✅
| Column | Type | Constraints / Notes |
|---|---|---|
| id | uuid | PK |
| name | text | NN, unique — `starter`·`growth`·`enterprise` |
| display_name | text | NN |
| is_active | boolean | NN, default true |
| created_at | timestamptz | NN, default now |
| updated_at | timestamptz | NN, default now |

## 22. `plan_entitlements` ✅
| Column | Type | Constraints / Notes |
|---|---|---|
| id | uuid | PK |
| plan_fk | uuid | FK → plans.id (cascade), NN |
| key | text | NN — `max_stores`, `max_devices_per_store`… |
| value | integer | nullable — null = unlimited |

Unique `(plan_fk, key)`.

## 23. `plan_features` ✅
| Column | Type | Constraints / Notes |
|---|---|---|
| id | uuid | PK |
| plan_fk | uuid | FK → plans.id (cascade), NN |
| key | text | NN — `barcode_scanning`, `multi_store`… |
| enabled | boolean | NN, default false |

Unique `(plan_fk, key)`.

## 24. `account_subscriptions` ✅
| Column | Type | Constraints / Notes |
|---|---|---|
| id | uuid | PK |
| account_fk | uuid | FK → accounts.id (cascade), NN, unique |
| plan_fk | uuid | FK → plans.id, NN |
| status | text enum | NN, default `trialing` — `trialing`·`active`·`past_due`·`paused`·`cancelled`·`expired` |
| trial_ends_at | timestamptz | nullable |
| current_period_start | timestamptz | nullable |
| current_period_end | timestamptz | nullable |
| past_due_grace_until | timestamptz | nullable |
| access_valid_until | timestamptz | nullable — guard reads this |
| cancel_at_period_end | boolean | NN, default false |
| subscription_version | integer | NN, default 1 |
| has_used_trial | boolean | NN, default false |
| razorpay_sub_id | text | nullable |
| created_at | timestamptz | NN, default now |
| updated_at | timestamptz | NN, default now |

Unique `(account_fk)`; CHECK `access_valid_until IS NOT NULL OR status='trialing'`.

## 25. `subscription_audit_outbox` ✅
| Column | Type | Constraints / Notes |
|---|---|---|
| id | uuid | PK |
| account_fk | uuid | FK → accounts.id (cascade), NN |
| event_type | text | NN |
| payload | jsonb | NN |
| created_at | timestamptz | NN, default now |
| processed_at | timestamptz | nullable — null = pending |

Partial index on pending rows `(created_at) WHERE processed_at IS NULL`.

## 26. `subscription_payment` 🕐
| Column | Type | Constraints / Notes |
|---|---|---|
| id | uuid | PK |
| guuid | uuid | NN, unique |
| subscription_fk | uuid | FK → account_subscriptions.id, NN |
| razorpay_payment_id | text | unique, nullable |
| razorpay_order_id | text | nullable |
| amount_paise | bigint | NN |
| currency | text | NN, default `INR` |
| status | text enum | NN, default `pending` — `pending`·`captured`·`failed`·`refunded` |
| paid_at | timestamptz | nullable |
| failed_at | timestamptz | nullable |
| failure_reason | text | nullable |
| period_start | timestamptz | nullable |
| period_end | timestamptz | nullable |
| refunded_amount_paise | bigint | nullable |
| raw_payload | jsonb | nullable |
| created_at | timestamptz | NN, default now |

## 27. `subscription_event` 🕐
| Column | Type | Constraints / Notes |
|---|---|---|
| id | uuid | PK |
| subscription_fk | uuid | FK → account_subscriptions.id, NN |
| event_type | text | NN — `activated`·`past_due`·`cancelled`·`trial_ended`… |
| from_status | text | nullable |
| to_status | text | nullable |
| triggered_by | text | nullable — `webhook`·`cron`·`user`/userId |
| meta | jsonb | nullable |
| created_at | timestamptz | NN, default now |

## 28. `subscription_billing_period` 🕐
| Column | Type | Constraints / Notes |
|---|---|---|
| id | uuid | PK |
| subscription_fk | uuid | FK → account_subscriptions.id, NN |
| period_start | timestamptz | NN |
| period_end | timestamptz | nullable |
| plan_code | text | NN |
| amount_paise | bigint | nullable |
| currency | text | NN, default `INR` |
| created_at | timestamptz | NN, default now |

---

## 29. `lookup_type` ➕
| Column | Type | Constraints / Notes |
|---|---|---|
| id | uuid | PK |
| code | varchar(40) | NN, unique — `PAYMENT_TERMS`, `REASONS`… |
| title | varchar(80) | NN |
| description | varchar(200) | nullable |
| has_table | boolean | NN, default false |
| is_custom_table | boolean | NN, default false |
| is_active | boolean | NN, default true |

## 30. `lookup` ➕
| Column | Type | Constraints / Notes |
|---|---|---|
| id | uuid | PK |
| lookup_type_fk | uuid | FK → lookup_type.id, NN |
| store_fk | uuid | FK → stores.id, nullable — null = global; set = store-custom |
| code | varchar(40) | NN |
| label | varchar(80) | NN |
| description | varchar(200) | nullable |
| sort_order | integer | NN, default 0 |
| is_hidden | boolean | NN, default false |
| is_system | boolean | NN, default false |
| is_active | boolean | NN, default true |
| created_at | timestamptz | NN, default now |
| updated_at | timestamptz | NN, default now |

Unique `(lookup_type_fk, code)` (per-type, **not** global); index `(lookup_type_fk)`.
**Use for:** PAYMENT_TERMS, CUSTOMER_TYPE, SUPPLIER_TYPE, REASONS, EXP_TYP, CHARGES, DISCOUNT_TYPE, DLVRY/DLCDN, STORAGE_TYPE, notification types.
**Not for** logic-bearing states (order/payment/refund status, supply_type, tracking_type, movement_type) — those stay `text` enums.

---

## 31. `sequences` ✅ *(🔧 orphaned — wire to numbering)*
| Column | Type | Constraints / Notes |
|---|---|---|
| type | text | **PK** — `order`·`refund`·`adjustment` |
| prefix | text | NN — `ORD`·`REF`·`ADJ` |
| counter | integer | NN, default 0 |
| year | integer | NN — resets on new calendar year |

## 32. `audit_logs` ✅
| Column | Type | Constraints / Notes |
|---|---|---|
| id | uuid | PK |
| event | text | NN |
| activity_type | text | NN |
| prefix | text | NN |
| suffix | text | NN |
| user_id | uuid | NN |
| actor_id | uuid | nullable |
| store_fk | uuid | nullable |
| is_success | boolean | NN, default true — false = denial |
| entity_type | text | nullable |
| entity_id | text | nullable |
| metadata | jsonb | nullable |
| ip_address | text | nullable |
| user_agent | text | nullable |
| created_at | timestamptz | NN, default now |

Indexes `(user_id, created_at)`, `(store_fk, created_at)`.

---

## 33. Files & Attachments — two-phase upload ➕

Adopted from ayphen-3.0 (`temporary_files → files + files_config`). **This replaces the single `attachment` table** — a proper pre-signed upload flow: the client uploads to `temporary_files` (staging), then on save the row is committed into `files` and linked to its parent entity. `files_config` sets per-entity limits enforced at upload time. All committed rows are polymorphic via `entity_type_fk` + `record_guuid` (sync-safe).

### 33.1 `temporary_files` ➕ — staging (uncommitted upload)
| Column | Type | Constraints / Notes |
|---|---|---|
| id | uuid | PK |
| guuid | uuid | NN, unique |
| file_name | varchar(255) | NN — original filename |
| storage_key | varchar(1000) | NN — object-store key/path |
| storage_url | text | nullable — full URL |
| size_bytes | bigint | NN |
| mime_type | varchar(100) | NN |
| sha256 | varchar(64) | nullable — integrity / dedup |
| uploaded_by | uuid | FK → users.id, nullable |
| expires_at | timestamptz | NN — staging TTL; a sweeper deletes uncommitted temps |
| created_at | timestamptz | NN, default now |

*Ephemeral — no soft-delete; unclaimed rows are purged after `expires_at`.*

### 33.2 `files` ➕ — committed attachment (polymorphic)
| Column | Type | Constraints / Notes |
|---|---|---|
| id | uuid | PK |
| guuid | uuid | NN, unique |
| entity_type_fk | uuid | FK → entity_types.id, NN — which entity (Product/Customer/Order…) |
| record_id | uuid | nullable — parent internal id |
| record_guuid | uuid | NN — **sync-safe parent ref** (client tracks by this) |
| store_fk | uuid | FK → stores.id, nullable (null = user-level) |
| kind | varchar(50) | NN — `image`·`document`·`receipt`·`logo`… |
| storage_key | varchar(1000) | NN |
| storage_url | text | nullable |
| thumbnail_url | text | nullable |
| mime_type | varchar(100) | NN |
| size_bytes | bigint | NN |
| sha256 | varchar(64) | nullable |
| original_filename | varchar(255) | nullable |
| is_private | boolean | NN, default true |
| description | varchar(255) | nullable |
| created_by | uuid | FK → users.id, nullable |
| updated_by | uuid | nullable |
| deleted_by | uuid | nullable |
| created_at / updated_at | timestamptz | NN, default now |
| deleted_at | timestamptz | nullable — soft-delete |

Indexes `(entity_type_fk, record_guuid)`, `(store_fk)`. *No DB FK on `record_id`/`record_guuid` (polymorphic) — enforce in app + orphan-cleanup job.*

### 33.3 `files_config` ➕ — per-entity upload limits
| Column | Type | Constraints / Notes |
|---|---|---|
| id | uuid | PK |
| entity_type_fk | uuid | FK → entity_types.id, NN |
| file_kind | varchar(50) | nullable — scope a rule to one kind |
| max_file_size_bytes | bigint | NN — per-file cap |
| max_consolidated_size_bytes | bigint | NN — total per (entity, record) cap |
| valid_extensions | varchar(1000) | NN — comma list (`jpg,png,pdf`) |
| max_attachments_allowed | integer | NN — count cap per record |
| is_active | boolean | NN, default true |
| created_at / updated_at | timestamptz | NN, default now |

Unique `(entity_type_fk, file_kind)`.

---

## 34. Polymorphic Common — contacts / notes / address ➕

The `entity_type_fk` + `record_guuid` polymorphic pattern, attaching to any entity. **All four carry `record_guuid`** (offline-sync consistency) and reference the `entity_types` registry by FK. `record_id` has no DB FK (polymorphic) — enforce in app.

### 34.1 `notes` ➕
| Column | Type | Constraints / Notes |
|---|---|---|
| id | uuid | PK |
| guuid | uuid | NN, unique |
| entity_type_fk | uuid | FK → entity_types.id, NN |
| record_id | uuid | nullable |
| record_guuid | uuid | NN |
| store_fk | uuid | FK → stores.id, NN |
| body | text | NN |
| is_pinned | boolean | NN, default false |
| created_by / updated_by / deleted_by | uuid | nullable |
| created_at / updated_at | timestamptz | NN, default now |
| deleted_at | timestamptz | nullable |

Index `(entity_type_fk, record_guuid)`.

### 34.2 `address` ➕
| Column | Type | Constraints / Notes |
|---|---|---|
| id | uuid | PK |
| guuid | uuid | NN, unique |
| entity_type_fk | uuid | FK → entity_types.id, NN |
| record_id | uuid | nullable |
| record_guuid | uuid | NN |
| address_type_lookup_fk | uuid | FK → lookup.id (type `ADDRESS_TYPE`) — billing/shipping/registered |
| line1 | varchar(200) | NN |
| line2 | varchar(200) | nullable |
| city | varchar(100) | nullable |
| state_code | varchar(2) | nullable — GST state code |
| pincode | varchar(6) | nullable |
| country_fk | uuid | FK → country.id, nullable |
| is_primary | boolean | NN, default false |
| is_billing | boolean | NN, default false |
| created_by / updated_by / deleted_by | uuid | nullable |
| created_at / updated_at | timestamptz | NN, default now |
| deleted_at | timestamptz | nullable |

Index `(entity_type_fk, record_guuid)`.

### 34.3 `communication` ➕ — contact channels (email/phone/fax/website)
| Column | Type | Constraints / Notes |
|---|---|---|
| id | uuid | PK |
| guuid | uuid | NN, unique |
| entity_type_fk | uuid | FK → entity_types.id, NN |
| record_id | uuid | nullable |
| record_guuid | uuid | NN |
| communication_type_lookup_fk | uuid | FK → lookup.id (type `COMMUNICATION_TYPE`) |
| email | varchar(255) | nullable |
| phone | varchar(20) | nullable |
| fax | varchar(20) | nullable |
| website | varchar(255) | nullable |
| calling_code | varchar(10) | nullable |
| is_verified | boolean | NN, default false |
| is_primary | boolean | NN, default false |
| created_by / updated_by / deleted_by | uuid | nullable |
| created_at / updated_at | timestamptz | NN, default now |
| deleted_at | timestamptz | nullable |

Index `(entity_type_fk, record_guuid)`.

### 34.4 `contact_person` ➕ — named contacts
| Column | Type | Constraints / Notes |
|---|---|---|
| id | uuid | PK |
| guuid | uuid | NN, unique |
| entity_type_fk | uuid | FK → entity_types.id, NN |
| record_id | uuid | nullable |
| record_guuid | uuid | NN |
| contact_type_lookup_fk | uuid | FK → lookup.id (type `CONTACT_PERSON_TYPE`) |
| salutation_lookup_fk | uuid | FK → lookup.id (type `TITLE`), nullable |
| first_name | varchar(50) | nullable |
| last_name | varchar(50) | nullable |
| designation | varchar(50) | nullable |
| email | varchar(255) | nullable |
| office_number | varchar(20) | nullable |
| mobile_number | varchar(20) | nullable |
| is_primary | boolean | NN, default false |
| created_by / updated_by / deleted_by | uuid | nullable |
| created_at / updated_at | timestamptz | NN, default now |
| deleted_at | timestamptz | nullable |

Index `(entity_type_fk, record_guuid)`.

> **Dependency:** all of §33–§34 require `entity_types` to be wired first (they FK into it), and `address`/`communication`/`contact_person` use `lookup` for their type columns. So order of build: wire `entity_types` → add `lookup_type`/`lookup` → add files + polymorphic tables.

---

## Inventory & counts

| # | Table | Status | | # | Table | Status |
|---|---|---|---|---|---|---|
| 1 | users | ✅ | | 17 | refresh_tokens | ✅ |
| 2 | accounts | ✅ | | 18 | otp_requests | ✅ |
| 3 | account_users | ✅ | | 19 | revoked_tokens | ✅ |
| 4 | stores | ✅ | | 20 | login_attempts | ✅ |
| 5 | locations | ✅ | | 21 | plans | ✅ |
| 6 | user_location_mappings | ✅ | | 22 | plan_entitlements | ✅ |
| 7 | roles | ✅ | | 23 | plan_features | ✅ |
| 8 | role_permissions | ✅ | | 24 | account_subscriptions | ✅ |
| 9 | role_special_permissions | ✅ | | 25 | subscription_audit_outbox | ✅ |
| 10 | user_role_mappings | ✅ | | 26 | subscription_payment | 🕐 |
| 11 | entity_types | ✅ 🔧 | | 27 | subscription_event | 🕐 |
| 12 | invitations | ✅ | | 28 | subscription_billing_period | 🕐 |
| 13 | invitation_locations | ➕ | | 29 | lookup_type | ➕ |
| 14 | devices | ✅ | | 30 | lookup | ➕ |
| 15 | device_sessions | ✅ | | 31 | sequences | ✅ 🔧 |
| 16 | store_device_access | ✅ | | 32 | audit_logs | ✅ |

**Files & polymorphic common (§33–§34):**

| # | Table | Status | | # | Table | Status |
|---|---|---|---|---|---|---|
| 33 | temporary_files | ➕ | | 37 | address | ➕ |
| 34 | files | ➕ | | 38 | communication | ➕ |
| 35 | files_config | ➕ | | 39 | contact_person | ➕ |
| 36 | notes | ➕ | | | | |

| | Count |
|---|---|
| ✅ Exist now | **26** |
| ➕ Add now | **10** (`invitation_locations`, `lookup_type`, `lookup`, `temporary_files`, `files`, `files_config`, `notes`, `address`, `communication`, `contact_person`) |
| 🕐 Add with paid tiers | **3** (`subscription_payment`, `subscription_event`, `subscription_billing_period`) |
| **Total (final)** | **39** |

### Fixes (behaviour, not new tables)
1. **Wire `entity_types`** — seeded but unread; needed before polymorphic `attachment`/`notes`/`address`.
2. **Wire `sequences`** — seeded but never incremented; connect to order/refund/adjustment numbering.
3. **Invitation-expiry cron** — `UPDATE invitations SET status='expired' WHERE status='pending' AND expires_at < now();`

> **Not covered:** the full POS retail domain (products, inventory, orders, customers, suppliers, shifts, cash, GST, sync infrastructure). See [`database-schema.md`](./database-schema.md) for the complete ~124-table target.
