# Ayphen Retail POS — Complete Database Schema

> **App:** Ayphen Retail POS (NestJS · Drizzle ORM · PostgreSQL · Redis · offline-first mobile POS)
> **Scope:** every table the application needs, grouped by domain, with every column.
> **Status legend:** ✅ = already built in `apps/backend/src/db/schema.ts` · ➕ = to add.

---

## 0. Conventions (read first)

Every column below is listed on top of a shared **base column set**. There are four base sets; each table says which one it uses.

### Base column sets

**`core` — syncable domain tables** (products, orders, inventory, customers, suppliers, stock, shifts…). These sync to the mobile SQLite client, so they carry a public `guuid` and an optimistic-concurrency `rowVersion`.
| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK (`defaultRandom`) | internal PK, used for FK joins |
| `guuid` | `uuid` unique (uuidv7) | **public** id — the client tracks rows by this across cold-starts |
| `row_version` | `bigint` default 1 | bumped on every UPDATE; drives conflict detection |
| `created_at` | `timestamptz` | |
| `modified_at` | `timestamptz` | |
| `deleted_at` | `timestamptz` null | soft-delete (null = active) |
| `created_by` / `modified_by` / `deleted_by` | `uuid → users.id` null | attribution |

**`ref` — reference / master data** (lookup, unit, tax_rate, country…). No sync/rowVersion; global or store-seeded.
| Column | Type |
|---|---|
| `id` | `uuid` PK |
| `created_at` / `updated_at` | `timestamptz` |
| `is_active` | `boolean` default true |

**`ledger` — append-only immutable rows** (credit ledgers, cash ledger, movements). Never UPDATEd; corrected by reversal rows.
| Column | Type |
|---|---|
| `id` | `uuid` PK |
| `guuid` | `uuid` unique |
| `created_at` | `timestamptz` |
| `created_by` | `uuid → users.id` |

**`junction` — pure join rows.**
| Column | Type |
|---|---|
| `id` | `uuid` PK |
| `created_at` | `timestamptz` |

### Global rules
- **Money is `bigint` in paise** (₹1 = 100). Never `DECIMAL`/float for currency. Column names end in `_paise`.
- **Quantities are `numeric(14,3)`** (support fractional units — kg, litre).
- **FKs are `uuid`** referencing the target's internal `id`.
- **Soft-delete** via `deleted_at` (domain) or `is_active` (reference); nothing is hard-deleted except via DPDP erasure (which flows through `tombstone`).
- **Tenant scoping:** every domain table carries `store_fk` (hard boundary); location-grained tables additionally carry `location_fk`.
- **snake_case** DB columns ↔ **camelCase** Drizzle fields.

### Domain index
0. [Conventions](#0-conventions-read-first)
1. [Identity, Sessions & Devices](#1-identity-sessions--devices)
2. [Tenancy — Account, Store, Location](#2-tenancy--account-store-location)
3. [RBAC](#3-rbac)
4. [Subscription & Billing](#4-subscription--billing)
5. [Reference / Master Data](#5-reference--master-data)
6. [Products & Catalogue](#6-products--catalogue)
7. [Inventory & Costing](#7-inventory--costing)
8. [Orders & POS Sales](#8-orders--pos-sales)
9. [Customers](#9-customers)
10. [Suppliers & Purchasing](#10-suppliers--purchasing)
11. [Shifts, Registers & Cash](#11-shifts-registers--cash)
12. [Refunds, Accounting & GST](#12-refunds-accounting--gst)
13. [Estimates & Delivery](#13-estimates--delivery)
14. [Offline-Sync Infrastructure](#14-offline-sync-infrastructure)
15. [Polymorphic Common](#15-polymorphic-common)
16. [HR & Scheduling](#16-hr--scheduling)
17. [Personal Finance](#17-personal-finance)
18. [System, Notifications & Audit](#18-system-notifications--audit)

---

## 1. Identity, Sessions & Devices

### `users` ✅ — global user identity (phone/OTP)
Base: custom (has own `guuid`). Columns: `id`, `guuid`, `email` (unique), `phone` (unique), `name`, `email_verified`, `phone_verified`, `primary_login_method` (otp|password|google), `permissions_version` (int, RBAC cache-bust), `status` (active|suspended|locked), `last_account_mode` (business|personal, null), `is_blocked`, `blocked_reason`, `failed_login_attempts`, `account_locked_until`, `mfa_enabled`, `password_changed_at`, `last_login_at`, `image_attachment_fk` (uuid), `deleted_at`, `created_at`, `updated_at`.

### `devices` ✅ — a physical device bound to a user (Ed25519 key)
`id`, `user_fk`, `public_key`, `public_key_hash`, `platform` (ios|android|web), `model`, `os_version`, `app_version`, `attestation_verified`, `is_trusted`, `is_blocked`, `label`, `first_seen_at`, `last_seen_at`, `last_ip`, `push_token`, `last_sync_at`, `blocked_at`. Unique `(user_fk, public_key_hash)`.

### `device_sessions` ✅ — an authenticated session on a device
`id`, `user_fk`, `device_fk`, `expires_at`, `last_used_at`, `last_step_up_at`, `last_step_up_method` (otp|password|biometric), `step_up_locked_until`, `revoked_at`, `revoked_reason`, `current_jti`, `current_jti_exp`, `ip_at_creation`, `geo_at_creation`, `device_name`, `os`, `app_version`, `platform`, `last_app_version`, `push_token`, `created_at`.

### `store_device_access` ✅ — the device↔store slot (enforces `max_devices_per_store`)
`id`, `store_fk`, `device_fk`, `user_fk`, `location_fk` (null until location layer live), `status` (active|revoked|expired), `device_label`, `first_accessed_at`, `last_accessed_at`, `revoked_at`, `revoked_by`, `revoked_reason` (owner_removed|stolen|auto_expired|plan_downgrade|released), `created_at`, `modified_at`. Partial-unique `(store_fk, device_fk) WHERE status='active'`.

### `refresh_tokens` ✅ — rotation chain with reuse detection
`id`, `device_session_fk`, `token_hash` (unique, sha-256), `parent_id` (self-ref chain), `family_id`, `issued_at`, `expires_at`, `used_at` (2nd use = reuse attack), `revoked_at`, `revoked_reason`.

### `otp_requests` ✅ — OTP challenge records
`id`, `phone`, `purpose` (login|signup|step_up), `attempts`, `max_attempts`, `consumed_at`, `expires_at`, `created_at`.

### `revoked_tokens` ✅ — JWT blacklist (persistent fallback behind Redis)
`jti` (PK), `expires_at`, `created_at`.

### `login_attempts` ✅ — rate-limiting log (IP / account / email / phone)
`id`, `ip`, `user_id`, `email`, `phone`, `purpose` (login|otp|signup), `success`, `created_at`.

---

## 2. Tenancy — Account, Store, Location

### `accounts` ✅ — top-level tenant / billing entity
`id`, `account_number` (unique), `name`, `owner_user_fk` (uuid → users; account-wide authority = ownership, not a role), `gst_number`, `billing_address` (jsonb), `razorpay_customer_id`, `created_at`, `updated_at`.

### `account_users` ✅ — user↔account membership (M:M)
`id`, `account_fk`, `user_fk`, `created_at`. Unique `(account_fk, user_fk)`.

### `stores` ✅ — a store under an account
`id`, `account_fk`, `name`, `gst_number`, `address`, `phone`, `email`, `invoice_prefix` (default 'INV'), `invoice_counter`, `is_active`, `locked`, + audit columns (`created_at`, `updated_at`, `deleted_at`, `created_by`, `modified_by`, `deleted_by`).
**Recommended additions** (from ayphen-3.0 / retail): `gst_scheme` (regular|composition|unregistered), `state_code`, `timezone` (default 'Asia/Kolkata'), `default_tax_inclusive`, `allow_negative_stock`, `cash_diff_alert_threshold_paise`, `default_tax_rate_fk`, `migration_date`, `pan`, `enforce_open_shift_before_sale`, `blind_close`, `require_manager_approval_for_override`, `locked_reason` (downgrade|account_expired), `archived_at`.

### `locations` ✅ — a branch under a store (Head Office auto-provisioned)
`id`, `store_fk`, `name`, `is_primary` (Head Office), `is_default` (device opens into), `enable`, `is_active`, `display_order`, `locked`, `archived_at`, `created_at`, `updated_at`. Partial-unique one primary + one default per store.

### `user_location_mappings` ✅ — which branches a user may work at
`id`, `user_fk`, `location_fk`, `assigned_by`, `assigned_at`, `revoked_at`. Unique `(user_fk, location_fk)`. (Store derives via `location.store_fk`.)

### `invitations` ✅ — staff invite to a store with a custom role
`id`, `store_fk`, `role_fk`, `phone`, `email`, `token` (unique), `status` (pending|accepted|revoked|expired), `invited_by`, `accepted_by`, `expires_at`, `accepted_at`, `created_at`.

### `invitation_locations` ➕ — the location set an invite grants
Base `junction`. `id`, `invitation_fk`, `location_fk` (null = all), `created_at`. → materialised into `user_location_mappings` on accept.

### `ownership_transfer` ➕ — dual-confirmation account/store ownership handoff
`id`, `store_fk`, `from_user_fk`, `to_user_fk`, `new_role_for_old_owner`, `from_user_confirmed_at`, `to_user_confirmed_at`, `from_user_final_confirmed_at`, `completed_at`, `cancelled_at`, `cancelled_reason`, `expires_at`.

---

## 3. RBAC

### `roles` ✅ — a role (system or custom)
`id`, `guuid` (unique), `store_fk` (null = system-wide role), `code`, `name`, `description`, `is_editable` (false for system), + audit. `STORE_OWNER` is a store-scoped system role; `USER`/`SUPER_ADMIN` are system-wide.

### `role_permissions` ✅ — CRUD grants (soft-deleted for point-in-time auth)
`id`, `role_fk`, `entity_code` (PascalCase), `action` (view|create|edit|delete), `granted_by`, `granted_at`, `revoked_at`. Unique `(role_fk, entity_code, action)`.

### `role_special_permissions` ✅ — beyond-CRUD grants (REFUND, VOID, EXPORT…)
`id`, `role_fk`, `entity_code`, `action_code` (SCREAMING_SNAKE), `granted_by`, `granted_at`, `revoked_at`. Unique `(role_fk, entity_code, action_code)`.

### `user_role_mappings` ✅ — user↔role assignment (store-scoped)
`id`, `user_fk`, `role_fk`, `store_fk` (null = system-wide), `assigned_by`, `assigned_at`, `revoked_at`, `expires_at`. Unique `(user_fk, role_fk, store_fk)`.

### `entity_types` ✅ — entity registry (drives offline allow-list)
`id`, `code` (unique — 'Product', 'Order'…), `label`, `is_offline_safe`, `supports_attachments`.

---

## 4. Subscription & Billing

### `plans` ✅ — plan catalogue
`id`, `name` (unique — starter|growth|enterprise), `display_name`, `is_active`, `created_at`, `updated_at`.

### `plan_entitlements` ✅ — numeric limits per plan (null = unlimited)
`id`, `plan_fk`, `key` (max_stores|max_devices_per_store|max_products…), `value` (int null). Unique `(plan_fk, key)`.

### `plan_features` ✅ — boolean capabilities per plan
`id`, `plan_fk`, `key` (barcode_scanning|multi_store|api_access…), `enabled`. Unique `(plan_fk, key)`.

### `account_subscriptions` ✅ — one subscription per account
`id`, `account_fk` (unique), `plan_fk`, `status` (trialing|active|past_due|paused|cancelled|expired), `trial_ends_at`, `current_period_start`, `current_period_end`, `past_due_grace_until`, `access_valid_until` (guard reads this), `cancel_at_period_end`, `subscription_version`, `has_used_trial`, `razorpay_sub_id`, `created_at`, `updated_at`.

### `subscription_audit_outbox` ✅ — transactional billing audit (drained to `audit_logs`)
`id`, `account_fk`, `event_type`, `payload` (jsonb), `created_at`, `processed_at` (null = pending).

### `subscription_payment` ➕ — payment records
`id` (+`guuid`), `subscription_fk`, `razorpay_payment_id` (unique), `razorpay_order_id`, `razorpay_invoice_id`, `amount_paise`, `currency` (default INR), `status`, `paid_at`, `failed_at`, `failure_reason`, `failure_code`, `period_start`, `period_end`, `refund_id`, `refunded_amount_paise`, `refunded_at`, `raw_payload` (jsonb), `created_at`.

### `subscription_event` ➕ — subscription lifecycle event log
`id`, `subscription_fk`, `event_type`, `from_status`, `to_status`, `triggered_by_system`, `meta` (jsonb), `created_at`.

### `subscription_billing_period` ➕ — per-period billing rows
`id`, `subscription_fk`, `period_start`, `period_end`, `plan_code`, `amount_paise`, `currency`, `created_at`.

---

## 5. Reference / Master Data

Base `ref` unless noted.

### `lookup_type` ➕ — categories of reference codes
`code` (unique), `title`, `has_table`, `is_custom_table`.

### `lookup` ➕ — generic reference values (validate `lookup_type_fk` in app)
`lookup_type_fk`, `store_fk` (null = global), `code`, `label`, `description`.

### `unit` ➕ — units of measure
`code` (unique), `label`, `unit_type`, `decimal_places`, `base_unit_fk` (self-ref), `conversion_factor` (numeric).

### `tax_rate` ➕ — GST rates
`code`, `label`, `store_fk` (null = global seeded), `description`, `display_order`, `is_seeded`, `is_active`. (Add rate percent + CGST/SGST/IGST split columns.)

### `currency` ➕
`code` (3-char unique), `symbol`, `label`, `decimal_places`.

### `country` ➕
`country_name` (unique), `iso_code2` (unique), `dial_code`, `currency_fk` (→ currency; **not** denormalised symbol), `timezone`.

### `state` ➕
`state_name` (unique), `iso_state_code` (unique), `is_union_territory`, `country_fk`.

### `district` ➕
`district_name`, `district_code`, `lgd_code`, `state_fk`.

### `payment_method` ➕ — tender methods (base `core`)
`store_fk`, `code`, `label`, `is_active`, `sort_order` + base.

### `payment_account` ➕ — money accounts (cash/bank/UPI/card/wallet)
`store_fk`, `account_type`, `name`, `description`, `is_system`, `is_default`, `is_active`, `display_order`, `bank_name`, `account_number`, `ifsc_code`, `account_holder_name`, `branch_name`, `upi_id`, `upi_provider`, `upi_linked_phone`, `terminal_id`, `terminal_provider`, `terminal_merchant_id`, `wallet_provider`, `wallet_linked_phone`, `opening_balance_paise`, + audit.

---

## 6. Products & Catalogue

Base `core` unless noted. All store-scoped.

### `product` ➕ — catalogue item
`store_fk`, `sku`, `name`, `description`, `category_lookup_fk`, `barcode`, `unit_fk`, `price_paise` (bigint Paise), `cost_price_paise`, `tax_rate_fk`, `stock_quantity` (numeric), `low_stock_threshold`, `is_active`, `is_barcoded`, `hsn_sac_code`, `track_quantity`, `pack`, `is_digital`, `selling_price_inclusive`, `image_attachment_fk`, `product_type` (goods|service), `reorder_quantity`, `tracking_type` (none|batch|serial|fefo), `variant_group_fk`, `variant_value`, `profit_margin_percent`, `min_selling_price_paise`, `is_favourite`, `display_order`, `default_supplier_fk`, `last_purchase_price_paise`, `last_purchased_at`, `pos_code`, `is_measure_to_sell`, `is_we_sell_this_item`, `is_we_buy_this_item`, `case_barcode`, `mrp_paise`, `volume_unit`, `volume_amount`, `weight_kg`, `notes`, `purchase_tax_rate_fk`, `sales_tax_rate_fk`. Unique per store: `sku`, `barcode`, `pos_code`, `case_barcode`. Ships `sync_delta` + `tombstone` indexes.

### `product_category` ➕
`store_fk`, `name`, `description`, `parent_category_fk` (self-ref tree), `default_tax_rate_fk`, `display_order`, `is_active`.

### `product_locations` ➕ — per-branch product state
`store_fk` (via product), `product_fk`, `company_location_fk`/`location_fk`, `default_storage_area_fk`, `is_available`, `out_of_stock`, `min_stock_level` (numeric).

### `product_tax_rate` ➕ — dated tax mapping
`store_fk`, `product_guuid`, `effective_from` (date), `notes`.

### `product_price_history` ➕ — selling-price change log (base `ledger`)
`store_fk`, `product_fk`, `selling_price_paise`, `is_inclusive`, `effective_from`, `changed_by`.

### `product_variant_group` ➕
`store_fk`, `name`, `attribute_name`, `is_active`.

### `product_type_tax_default` ➕
`store_fk`, `product_type`, `default_tax_rate_fk`.

### `hsn_tax_rate_mapping` ➕
`store_fk`, `hsn_prefix`, `tax_rate_fk`, `is_seeded`.

### `product_bundle` ➕ — combo/bundle products
`store_fk`, `name`, `description`, `barcode`, `selling_price_paise`, `is_active`, `is_favourite`, `display_order`.

### `product_bundle_item` ➕
`bundle_fk`, `store_fk`, `product_guuid`, `quantity`, `product_name_snap`, `unit_price_paise_snap`, `tax_rate_percent_snap`.

### `product_batch` ➕ — batch/expiry tracking
`store_fk`, `product_guuid`, `purchase_guuid`, `batch_number`, `manufacture_date`, `expiry_date`, `quantity_received`, `quantity_remaining`, `storage_location`, `status`.

### `product_serial` ➕ — serialised units + warranty
`store_fk`, `product_guuid`, `purchase_guuid`, `serial_number`, `warranty_months`, `status`, `order_guuid`, `sold_at`, `warranty_expires_at`.

### `product_cases` ➕ — case/carton pricing
`store_fk`, `product_fk`, `case_quantity`, `case_code`, `rsp_paise`, `mrp_paise`, `case_cost_paise`, `is_default`, + audit.

### `discount_scheme` ➕ — promotions
`store_fk`, `name`, `description`, `scheme_type`, `min_quantity`, `min_amount_paise`, `discount_percent`, `discount_amount_paise`, `applicable_product_guuid`, `applicable_category_fk`, `start_date`, `end_date`, `is_active`, `priority`.

---

## 7. Inventory & Costing

### `inventory_balance` ➕ — on-hand per (store, product) — base `settings`
`store_fk`, `product_fk`, `quantity_on_hand` (numeric), `quantity_reserved`, `weighted_avg_cost_paise`, `last_counted_at`, `is_available`, `is_out_of_stock`, `default_storage_area`. Unique `(store_fk, product_fk)`.

### `inventory_movement` ➕ — every stock change (append-only)
`guuid`, `store_fk`, `product_fk`, `movement_type`, `quantity_change` (numeric ±), `quantity_after`, `adjustment_type`, `value_change_paise`, `requires_investigation`, `expiry_date`, `reference_type`, `reference_id`, `reason`, `created_by`.

### `inventory_cost_layer` ➕ — FIFO/landed cost layers
`store_fk`, `product_guuid`, `purchase_guuid`, `qty_total`, `qty_remaining`, `unit_cost_paise`, `landed_cost_paise`, `received_at`, `is_exhausted`.

### `inventory_cogs_mapping` ➕ — which cost layers a sale consumed
`store_fk`, `order_fk`, `order_item_guuid`, `cost_layer_guuid`, `qty_consumed`, `unit_cost_paise`, `landed_cost_paise`, `total_cogs_paise`.

### `fifo_cost_layer` ➕ — per-location FIFO layers
`store_fk`, `product_guuid`, `location_fk`, `storage_area`, `purchase_date`, `source_transaction_guuid`, `unit_cost_paise`.

---

## 8. Orders & POS Sales

### `order` ➕ — the sale (base `core`)
`store_fk`, `location_fk`, `shift_session_fk`, `customer_fk`, `cashier_fk`, `status` (pending_sync|completed|voided|refunded|partially_refunded), `invoice_number`, `financial_year`, `order_date`, `client_modified_at`, `supply_type` (intra_state|inter_state), `place_of_supply`, `seller_gstin`, `seller_state_code`, `buyer_gstin`, `buyer_state_code`, `subtotal_paise`, `discount_paise`, `taxable_value_paise`, `cgst_amount_paise`, `sgst_amount_paise`, `igst_amount_paise`, `total_tax_paise`, `round_off_paise`, `total_paise`, `payment_status` (paid|credit|partial|refunded), `amount_paid_paise`, `voided_at`, `voided_by`, `void_reason`, `has_refund`, `notes`, `document_type` (tax_invoice|sales_receipt|delivery_challan), `sales_channel` (pos|phone|whatsapp|online), `reference`, `is_tax_inclusive`, `is_on_hold`, `hold_reason`, `held_at`, `is_split_payment`, `change_due_paise`, `salesperson_fk`, `billing_address_snapshot`, `delivery_address`, `is_seen`, `is_sent`. Unique `(store_fk, invoice_number)`; ships `sync_delta` + `tombstone` indexes.

### `order_item` ➕ — sale line (snapshots price/tax at sale time)
`store_fk`, `order_fk`, `product_fk`, `product_name_snapshot`, `hsn_sac_code_snapshot`, `unit_snapshot`, `unit_price_incl_paise`, `unit_price_excl_paise`, `quantity`, `pack_quantity`, `discount_type`, `discount_paise`, `gross_amount_paise`, `taxable_amount_paise`, `tax_rate_percent`, `cgst_rate_percent`, `sgst_rate_percent`, `igst_rate_percent`, `cgst_amount_paise`, `sgst_amount_paise`, `igst_amount_paise`, `tax_amount_paise`, `line_total_paise`, `landed_cost_paise`, `cogs_paise`, `cogs_method`, `sort_order`, `discount_scheme_fk`, `service_from_date`, `service_to_date`, `warranty_months`, `batch_guuid`, `serial_number`, `bundle_guuid`, `bundle_name_snapshot`, `tax_rate_override_percent`, `tax_rate_override_reason`, `tax_rate_override_by`, + audit.

### `order_payment` ➕ — tenders against a sale (split payment = many rows)
`order_fk`, `store_fk`, `register_fk`, `payment_method`, `amount_paise`, `tendered_paise`, `change_paise`, `upi_reference`, `upi_app`, `card_reference`, `terminal_id`, `card_last_four`, `card_type`, `card_network`, `cheque_number`, `cheque_date`, `cheque_bank`, `cheque_status`, `bank_reference`, `advance_guuid`, `custom_method_name`, `payment_account_guuid`, `collected_at`, `collected_by`, + audit.

### `order_summary` ➕ — denormalised per-order rollup for reporting
`order_fk`, `store_fk`, `financial_year`, `order_month`, `order_date`, `order_hour`, `gross_sales_paise`, `discount_paise`, `taxable_value_paise`, `cgst_paise`, `sgst_paise`, `igst_paise`, `net_sales_paise`, `items_count`, `cash_collected_paise`, `upi_collected_paise`, `card_collected_paise`, `credit_issued_paise`, `supply_type`, `cashier_fk`, `register_fk`, `customer_fk`, `is_credit_sale`, `created_at`.

### `register` ➕ — POS terminal
`store_fk`, `location_fk`, `name`, `description`, `is_active`, `accepts_cash`, `accepts_upi`, `accepts_card`, `accepts_credit`, `accepts_cheque`, `carry_forward_float_paise`, `cash_diff_alert_threshold_paise`, `card_terminal_id`, + audit.

---

## 9. Customers

### `customer` ➕ — customer master (base `core`)
`store_fk`, `name`, `phone`, `email`, `customer_code`, `customer_type` (WALK_IN|REGULAR|WHOLESALE|B2B), `is_system`, `gstin`, `pan_number`, `billing_state_code`, `credit_limit_paise`, `override_credit_limit`, `payment_term_lookup_fk`, `payment_term_days`, `total_spend_paise`, `first_purchase_at`, `last_purchase_at`, `birthday`, `anniversary`, `loyalty_points_balance`, `marketing_opted_in_at`, `marketing_opted_out_at`, `marketing_opt_in_method`, `preferred_language`, `address_line_1`, `address_line_2`, `city`, `district`, `state`, `pin_code`, `website`, `customer_id` (display CUS-001), `image_attachment_fk`, `is_enabled`, `notes`, + audit. Unique per store on phone / gstin / customer_code; one WALK_IN per store.

### `customer_contact` ➕ — additional contacts
`store_fk`, `customer_fk`, `name`, `designation`, `phone`, `email`, `is_primary`, + audit.

### `customer_credit_ledger` ➕ — credit movements (base `ledger`)
`store_fk`, `customer_fk`, `entry_type`, `amount_paise`, `balance_after_paise`, `reference_type`, `reference_guuid`, `notes`, `created_by`.

### `customer_advance` ➕ — customer prepayments
`store_fk`, `customer_fk`, `advance_number`, `amount_paise`, `balance_paise`, `payment_method`, `reference`, `notes`, `received_at`, `received_by`, `status`, + audit.

### `credit_note_balance` ➕ — refund credit notes
`store_fk`, `customer_fk`, `credit_note_order_guuid`, `original_amount_paise`, `used_amount_paise`, `remaining_paise`, `status`, `created_at`.

---

## 10. Suppliers & Purchasing

### `supplier` ➕ — supplier master (base `core`)
`store_fk`, `name`, `display_name`, `phone`, `email`, `website`, `contact_person_name`, `supplier_type_lookup_fk`, `gstin`, `pan_number`, `cin`, `is_tax_registered`, `is_tds_applicable`, `tds_section`, `billing_type_lookup_fk`, `payment_term_lookup_fk`, `payment_term_days`, `bank_account_number`, `bank_ifsc_code`, `bank_account_holder_name`, `upi_id`, `credit_limit_paise`, `override_credit_limit`, `address_line_1`, `address_line_2`, `city`, `district`, `state`, `pin_code`, `supplier_id` (display), `logo_fk`, `notes`, `is_enabled`, + audit.

### `supplier_contact` ➕
`store_fk`, `supplier_fk`, `name`, `designation`, `phone`, `email`, `is_primary`, + audit.

### `supplier_balance_ledger` ➕ — payables movements (base `ledger`)
`store_fk`, `supplier_fk`, `entry_type`, `amount_paise`, `balance_after_paise`, `reference_type`, `reference_guuid`, `notes`, `created_by`.

### `supplier_price_list` ➕
`store_fk`, `supplier_fk`, `name`, `effective_from`, `effective_to`, `is_active`.

### `supplier_price_list_item` ➕
`price_list_fk`, `store_fk`, `product_guuid`, `product_name_snap`, `supplier_sku`, `unit_cost_excl_tax_paise`, `tax_rate_percent`, `min_order_qty`.

### `purchase` ➕ — goods-in (base `core`)
`store_fk`, `supplier_fk`, `purchase_number`, `financial_year`, `purchase_date`, `supplier_invoice_number`, `supply_type`, `subtotal_paise`, `discount_paise`, `taxable_value_paise`, `cgst_amount_paise`, `sgst_amount_paise`, `igst_amount_paise`, `total_tax_paise`, `total_paise`, `payment_status`, `amount_paid_paise`, `notes`.

### `purchase_item` ➕
`store_fk`, `purchase_fk`, `product_guuid`, `product_name_snapshot`, `hsn_sac_code_snapshot`, `quantity`, `unit_cost_paise`, `gross_amount_paise`, `discount_paise`, `taxable_amount_paise`, `tax_rate_percent`, `cgst_rate_percent`, `sgst_rate_percent`, `igst_rate_percent`, `cgst_amount_paise`, `sgst_amount_paise`, `igst_amount_paise`, `tax_amount_paise`, `line_total_paise`, `landed_cost_paise`, `batch_number`, `expiry_date`.

### `purchase_return` ➕
`store_fk`, `supplier_fk`, `return_number`, `financial_year`, `original_purchase_guuid`, `return_date`, `reason`, `supply_type`, `subtotal_paise`, `cgst_amount_paise`, `sgst_amount_paise`, `igst_amount_paise`, `total_paise`, `status`, `authorized_by`, `authorized_at`, `notes`.

### `purchase_return_item` ➕
`purchase_return_fk`, `product_guuid`, `product_name_snapshot`, `quantity`, `unit_cost_paise`, `tax_rate_percent`, `cgst_amount_paise`, `sgst_amount_paise`, `igst_amount_paise`, `line_total_paise`, `return_reason`.

### `purchase_request` ➕ — reorder request/approval
`store_fk`, `requester_fk`, `product_guuid`, `requested_quantity`, `reason`, `status`, `approved_by`, `approved_at`, `purchase_order_guuid`.

---

## 11. Shifts, Registers & Cash

### `shift` ➕ — shift definition (e.g. Morning/Evening)
`code`, `name`, `description`, `store_fk`, `is_active`.

### `shift_assignment` ➕ — user↔shift (dated)
`user_fk`, `shift_fk`, `store_fk`, `valid_from`, `valid_to`, `assigned_by`, `assigned_at`, `revoked_by`, `revoked_at`, `revoked_reason`.

### `shift_session` ➕ — an open/close cash session on a register
`store_fk`, `location_fk`, `register_fk`, `shift_fk`, `opened_by_user_fk`, `closed_by_user_fk`, `opened_at`, `closed_at`, `opening_float_paise`, `closing_float_paise`, `expected_cash_paise`, `counted_cash_paise`, `variance_paise`, `cash_diff_alert_threshold_paise`, `status`, `paused_total_ms`, `rota_entry_fk`, `opening_note`, `closing_note`, `closing_snapshot`, `z_report_generated_at`, `notes`.

### `shift_event` ➕ — shift audit trail (append-only)
`store_fk`, `shift_session_fk`, `event_type`, `actor_user_fk`, `payload` (jsonb), `client_event_at`, `created_at`.

### `shift_reconciliation` ➕ — Z-report / end-of-shift totals
`store_fk`, `shift_session_guuid`, `register_fk`, `cashier_fk`, `date`, `total_transactions`, `voided_transactions`, `gross_sales_paise`, `refunds_paise`, `discounts_paise`, `cgst_collected_paise`, `sgst_collected_paise`, `igst_collected_paise`, `cash_sales_paise`, `upi_sales_paise`, `card_sales_paise`, `cheque_sales_paise`, `bank_transfer_sales_paise`, `credit_issued_paise`, `store_credit_used_paise`, `custom_method_sales_paise`, `upi_transaction_count`, `upi_gpay_paise`, `upi_phonepe_paise`, `upi_paytm_paise`, `upi_other_paise`, `card_transaction_count`, `card_terminal_batch_id`, `card_terminal_amount_paise`, `opening_float_paise`, `closing_float_paise`, `cash_refunds_paise`, `safe_drops_paise`, `petty_cash_out_paise`, `petty_cash_in_paise`, `supplier_payments_paise`, `credit_payments_paise`, `owner_withdrawals_paise`, `cash_expected_paise`, `cash_actual_paise`, `cash_difference_paise`, `first_invoice_number`, `last_invoice_number`, `reconciled_by`, `reconciled_at`, `manager_reviewed_by`, `manager_reviewed_at`, `manager_review_notes`, `notes`.

### `cash_movement` ➕ — cash in/out during a shift
`store_fk`, `shift_session_fk`, `register_fk`, `movement_type`, `amount_paise`, `reason`, `reference`, `performed_by_user_fk`, `approved_by_user_fk`, `client_event_at`, `created_at`, `modified_at`.

### `cash_drawer_entry` ➕ — drawer ledger (base `ledger`)
`shift_session_guuid`, `store_fk`, `entry_type`, `amount_paise`, `direction`, `reason`, `reference_type`, `reference_guuid`, `authorized_by`, `created_by`.

### `cash_denomination_count` ➕ — denomination breakdown at close
`reconciliation_guuid`, `store_fk`, `denomination_paise`, `count`.

### `store_cash_ledger` ➕ — store-level cash ledger (base `ledger`)
`store_fk`, `entry_type`, `amount_paise`, `balance_after_paise`, `reference_type`, `reference_guuid`, `shift_session_guuid`, `notes`, `created_by`.

### `store_opening_balance` ➕ — migration opening balances
`store_fk`, `balance_type`, `amount_paise`, `as_of_date`, `customer_fk`, `supplier_fk`, `product_guuid`, `notes`, `created_by`.

---

## 12. Refunds, Accounting & GST

### `refund` ➕ — credit note against a sale
`store_fk`, `original_order_guuid`, `credit_note_number`, `financial_year`, `refund_date`, `reason`, `refund_method`, `refund_amount_paise`, `taxable_reversed_paise`, `cgst_reversed_paise`, `sgst_reversed_paise`, `igst_reversed_paise`, `tax_reversed_paise`, `approved_by`, `status`, + audit.

### `refund_item` ➕
`guuid`, `refund_guuid`, `original_item_guuid`, `quantity_returned`, `unit_price_excl_paise`, `taxable_amount_paise`, `tax_rate_percent`, `cgst_reversed_paise`, `sgst_reversed_paise`, `igst_reversed_paise`, `tax_reversed_paise`, `line_credit_paise`.

### `transaction_link` ➕ — links between documents (order→refund, estimate→order)
`store_fk`, `parent_guuid`, `parent_type`, `child_guuid`, `child_type`, `link_type`, `amount_paise`, `created_by`.

### `invoice_sequence` ➕ — per-store per-year invoice counter
`store_fk`, `financial_year`, `prefix`, `last_number`.

### `expense` ➕ — store expenses (recurring supported)
`store_fk`, `shift_session_fk`, `category`, `description`, `amount_paise`, `payment_method`, `expense_date`, `receipt_ref`, `is_billable`, `billable_customer_fk`, `billable_order_guuid`, `billed_at`, `recurrence_type`, `recurrence_day`, `recurrence_end_date`, `recurrence_template_fk`, `last_generated_at`, `next_due_at`, + audit.

### `expense_budget` ➕
`store_fk`, `category`, `financial_year`, `month_number`, `budget_paise`.

### `staff_reimbursement` ➕
`store_fk`, `requested_by`, `amount_paise`, `description`, `receipt_attachment_fk`, `status`, `approved_by`, `approved_at`, `paid_from`, `paid_at`, `created_at`.

### `store_auth_rule` ➕ — manager-approval thresholds
`store_fk`, `action_type`, `requires_auth_above_paise`, `requires_auth_above_percent`, `auth_role`.

### `gst_filing_period` ➕ — GSTR-1/3B tracking
`store_fk`, `financial_year`, `period_month`, `period_start_date`, `period_end_date`, `gstr1_due_date`, `gstr1_status`, `gstr1_filed_date`, `gstr3b_due_date`, `gstr3b_status`, `gstr3b_filed_date`, `gstr3b_tax_paid_paise`, `output_cgst_paise`, `output_sgst_paise`, `output_igst_paise`, `input_cgst_paise`, `input_sgst_paise`, `input_igst_paise`, `ca_shared_at`, `notes`.

### `store_gstin_history` ➕ — GSTIN change log
`store_fk`, `gstin`, `effective_from`, `effective_to`, `reason`.

---

## 13. Estimates & Delivery

### `estimate` ➕ — quotation (convertible to order)
`store_fk`, `customer_fk`, `estimate_number`, `financial_year`, `valid_until`, `status`, `converted_order_guuid`, `subtotal_paise`, `total_paise`, `notes`.

### `delivery_note` ➕ — delivery/dispatch tracking
`store_fk`, `sales_order_guuid`, `order_guuid`, `delivery_number`, `financial_year`, `delivery_type`, `status`, `delivery_address`, `delivery_phone`, `scheduled_at`, `picked_at`, `packed_at`, `dispatched_at`, `delivered_at`, `delivery_person_fk`, `failure_reason`, `notes`.

### `delivery_item` ➕
`delivery_note_fk`, `store_fk`, `product_guuid`, `product_name_snap`, `ordered_quantity`, `picked_quantity`, `delivered_quantity`, `condition`, `temperature_ok`, `is_counted`, `receiver_notes`.

---

## 14. Offline-Sync Infrastructure

### `tombstone` ➕ — guuid-keyed deletion propagation (append-only, 180-day retention)
`id`, `entity_type`, `entity_guuid`, `store_fk` (null for store-less), `deleted_at`, `deleted_by_fk`, `deleted_by_display_name`, `is_hard_delete`. Unique `(entity_type, entity_guuid)`.

### `mutation_idempotency` ➕ — replay cache (PK = `mutation_id` + `user_fk`)
`mutation_id` (ULID), `user_fk`, `store_fk`, `device_session_fk`, `result` (applied|rejected|conflict), `result_payload` (jsonb), `entity_type`, `entity_id`, `recorded_at`, `expires_at`, `payload_version`.

### `outbox_event` ➕ — transactional event outbox
`id`, `event_id` (uuid unique), `aggregate_type`, `aggregate_id`, `event_type`, `payload` (jsonb), `correlation_id`, `causation_id`, `attempts`, `published_at`, `failed_at`, `failure_reason`, `next_attempt_at`, `dead_lettered_at`, `created_by`, `created_at`.

### `sync_init_progress` ➕ — cold-start `/sync/initial` progress
`store_fk`, `device_fk`, `entity_type`, `phase` (in_progress|completed), `cursor`, `started_at`, `completed_at`, `session_started_at`.

### `local_sync_conflict` ➕ — rejected/conflicted client mutations
`id`, `mutation_id`, `entity_type`, `entity_guuid`, `action` (create|update|delete), `store_fk`, `user_fk`, `device_fk`, `reason` (rejected|conflict), `code`, `message`, `payload` (jsonb), `server_row` (jsonb), `status` (pending|resolved|discarded), `resolved_at`, `resolution_note`, `created_at`.

### `device_sync_health` ➕ — per-device sync telemetry
`device_fk`, `store_fk`, `last_delta_at`, `last_push_at`, `last_cold_start_at`, `cold_start_complete`, `pending_mutations_reported`.

---

## 15. Polymorphic Common

Attach to any entity via `entity_type_fk` (→ `entity_types`) + `record_id`/`record_guuid`. **Note:** carry `record_guuid` on all three for offline-sync consistency (see schema review); no DB-level FK on `record_id` is possible — enforce in app + orphan-cleanup job.

### `attachment` ➕ — files/images
`entity_type_fk`, `record_id`, `record_guuid`, `kind`, `storage_url`, `storage_key`, `mime_type`, `size_bytes`, `original_filename`, `thumbnail_url`, `status` (pending|committed), `sha256`, `client_mutation_id`, `multipart_upload_id`, + audit.

### `notes` ➕
`store_fk`, `entity_type_fk`, `record_id` (nullable — not magic 0), `record_guuid`, `body`, `is_pinned`, + audit.

### `address` ➕
`entity_type_fk`, `record_id`, `record_guuid`, `address_type_lookup_fk`, `line1`, `line2`, `city`, `state_code`, `pincode`, `is_primary`, + audit.

### `opening_hours` ➕ — store weekly hours
`store_fk`, `day_of_week`, `open_time` (int minutes), `close_time`, `is_closed`.

### `store_special_hours` ➕ — holiday/exception hours
`store_fk`, `date`, `open_time`, `close_time`, `is_closed`, `note`.

---

## 16. HR & Scheduling

### `rota_entry` ➕ — a scheduled shift for a user (base: integer id + guuid)
`store_fk`, `week_start_date`, `day_of_week`, `user_fk`, `shift_definition_fk`, `service_area_fk`, `register_fk`, `status`, `actual_start_time`, `actual_end_time`, `shift_session_fk`, `late_minutes`, `absence_reason`, `swapped_with_user_fk`, `notes`, `created_at`, `modified_at`, `created_by`.

### `rota_template` ➕
`store_fk`, `name`, `description`, `is_active`, `created_at`, `created_by`.

### `rota_template_entry` ➕
`template_fk`, `store_fk`, `day_of_week`, `user_fk`, `shift_definition_fk`, `service_area_fk`, `register_fk`.

### `leave_request` ➕
`store_fk`, `user_fk`, `leave_date`, `leave_type`, `reason`, `status`, `reviewed_by`, `reviewed_at`, `review_note`, `cover_user_fk`, `cover_confirmed`, `rota_entry_guuid`, `created_at`.

### `service_area` ➕ — delivery/coverage zones
`store_fk`, `name`, `description`, `color_hex`, `is_active`, `display_order`, `created_by`.

---

## 17. Personal Finance

### `personal_expense` ➕ — user-level expense (non-retail feature)
`user_fk`, `amount_paise`, `category_lookup_fk`, `description`, `notes`, `receipt_attachment_guuid`, `paid_at`, `client_timestamp`, `payment_method_lookup_fk`, + audit.

### `personal_budget` ➕
`user_fk`, `category_lookup_fk`, `monthly_limit_paise`, `period_start`, + audit.

---

## 18. System, Notifications & Audit

### `system_config` ➕ — global key-value config
`key` (unique), `value`, `description`, `is_secret`.

### `user_preference` ➕ — per-user settings
`user_fk`, `theme`, `timezone`, `notifications_enabled`.

### `push_notification` ➕ — push/notification log
`store_fk`, `user_fk`, `title`, `body`, `data` (jsonb), `channel`, `is_read`, `read_at`, `sent_at`, `expo_ticket_id`, `expo_receipt_id`, `status`, `error_message`, `created_at`.

### `email_template` ➕
`template_key`, `subject`, `body_html`, `body_text`, `is_active`, `created_at`, `modified_at`.

### `sequences` ✅ — generic document numbering
`type` (PK), `prefix`, `counter`, `year`. *(Wire to order/refund/adjustment numbering.)*

### `audit_logs` ✅ — append-only activity log
`id`, `event`, `activity_type`, `prefix`, `suffix`, `user_id`, `actor_id`, `store_fk`, `is_success` (false = denial), `entity_type`, `entity_id`, `metadata` (jsonb), `ip_address`, `user_agent`, `created_at`.

---

## Table count summary

| Domain | Tables | Have | Add |
|---|---|---|---|
| 1. Identity/Sessions/Devices | 7 | 7 | 0 |
| 2. Tenancy | 8 | 6 | 2 |
| 3. RBAC | 5 | 5 | 0 |
| 4. Subscription/Billing | 8 | 5 | 3 |
| 5. Reference/Master | 10 | 0 | 10 |
| 6. Products | 15 | 0 | 15 |
| 7. Inventory | 5 | 0 | 5 |
| 8. Orders/POS | 5 | 0 | 5 |
| 9. Customers | 5 | 0 | 5 |
| 10. Suppliers/Purchasing | 10 | 0 | 10 |
| 11. Shifts/Cash | 10 | 0 | 10 |
| 12. Refunds/Accounting/GST | 9 | 0 | 9 |
| 13. Estimates/Delivery | 3 | 0 | 3 |
| 14. Sync infrastructure | 6 | 0 | 6 |
| 15. Polymorphic common | 5 | 0 | 5 |
| 16. HR/Scheduling | 5 | 0 | 5 |
| 17. Personal finance | 2 | 0 | 2 |
| 18. System/Notifications/Audit | 6 | 2 | 4 |
| **Total** | **~124** | **~38** | **~86** |

### Build order (recommended)
- **Phase A** — finish tenancy gaps: `invitation_locations`, `ownership_transfer`; wire `sequences`.
- **Phase B** — Reference (§5) + Sync infrastructure (§14) together (POS needs both first).
- **Phase C** — Core POS: Products (§6) → Inventory (§7) → Orders (§8) → Customers (§9) → Payment methods.
- **Phase D** — Shifts/Cash (§11), Suppliers/Purchasing (§10).
- **Phase E** — Refunds/Accounting/GST (§12), Estimates/Delivery (§13).
- **Phase F** — Polymorphic (§15), Billing history (§4), HR (§16), Personal (§17), System/Notifications (§18).

### Notes
- Adopt `guuid` + `row_version` on every **§6–§14** table (the syncable/operational set) even though the rest of the schema is `uuid`-only — the mobile client needs a stable sync key and conflict-detection version.
- All money is `bigint` paise; all quantities `numeric(14,3)`.
- `_snapshot`/`_snap` columns intentionally denormalise product name/price/tax onto order & purchase lines so historical documents never change when the master record does.
