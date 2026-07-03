# Payment Accounts — Ayphen Retail Mobile

Complete reference for the Payment Accounts module. Every field, every flow, every business rule, and every real-world scenario for Indian retail.

---

## Table of contents

1. [What this module does](#1-what-this-module-does)
2. [Account types](#2-account-types)
3. [System accounts — auto-created](#3-system-accounts--auto-created)
4. [Data model — complete schema](#4-data-model--complete-schema)
5. [Field specifications — Common fields](#5-field-specifications--common-fields)
6. [Field specifications — Bank-type fields](#6-field-specifications--bank-type-fields)
7. [Field specifications — UPI-type fields](#7-field-specifications--upi-type-fields)
8. [Field specifications — Card Terminal-type fields](#8-field-specifications--card-terminal-type-fields)
9. [Field specifications — Wallet-type fields](#9-field-specifications--wallet-type-fields)
10. [Field specifications — Cash-type fields](#10-field-specifications--cash-type-fields)
11. [Field specifications — Other-type fields](#11-field-specifications--other-type-fields)
12. [Form behaviour — how fields interact](#12-form-behaviour--how-fields-interact)
13. [Account create flow](#13-account-create-flow)
14. [Account edit flow](#14-account-edit-flow)
15. [Account deactivate flow](#15-account-deactivate-flow)
16. [Account delete flow](#16-account-delete-flow)
17. [Accounts list screen](#17-accounts-list-screen)
18. [Account detail screen](#18-account-detail-screen)
19. [Where accounts are used across the app](#19-where-accounts-are-used-across-the-app)
20. [POS checkout — payment method selection](#20-pos-checkout--payment-method-selection)
21. [Split payments — multi-account checkout](#21-split-payments--multi-account-checkout)
22. [System Cash Register — special account](#22-system-cash-register--special-account)
23. [Account status lifecycle](#23-account-status-lifecycle)
24. [RBAC — role-based access control](#24-rbac--role-based-access-control)
25. [Offline-first behaviour](#25-offline-first-behaviour)
26. [Sync behaviour](#26-sync-behaviour)
27. [Business rules — complete list](#27-business-rules--complete-list)
28. [Validation matrix](#28-validation-matrix)
29. [Real-world scenarios](#29-real-world-scenarios)
30. [Dos and don'ts](#30-dos-and-donts)
31. [Phase 2 — what is deferred](#31-phase-2--what-is-deferred)

---

## 1. What this module does

The Payment Accounts module manages the physical and digital places where a store's money sits. When a customer pays ₹850 for groceries, the system needs to know WHERE that money went — did it land in the cash drawer? In the PhonePe business account? Through the card terminal? Into the bank via NEFT?

In a kirana store, money flows through many channels every day. Without named accounts, the owner has no way to reconcile end-of-day cash, track UPI settlements, or know which terminal processed which card payment.

**What it enables:**
- Owner defines every payment destination: cash drawers, bank accounts, UPI handles, card terminals, digital wallets
- At POS checkout, the cashier selects which account receives the payment — or splits across multiple accounts
- End-of-day reconciliation shows balance per account: cash drawer ₹12,400, PhonePe ₹8,200, card terminal ₹3,100
- Supplier payments reference which account the money left from
- Customer payment collections reference which account the money arrived in
- System auto-creates one "Cash Register" account at store setup — every store has cash on Day 1

**What it does not do (Phase 1):**
- No real-time bank balance sync (no bank API integrations)
- No automatic UPI settlement tracking (manual reconciliation only)
- No account-to-account transfers within the app (e.g. cash deposit into bank)
- No cheque management workflow (deposit → clearing → bounced)
- No multi-currency (INR only)
- No interest tracking on bank accounts
- No payment gateway integrations (Razorpay, PayU, etc. for online orders)

---

## 2. Account types

Every payment account has exactly one type. The type determines which fields appear on the create/edit form and how the account is grouped on the POS checkout screen.

| Type | What it represents | Indian retail examples |
|------|-------------------|----------------------|
| **Cash** | Physical cash in a register, drawer, or safe | "Cash Register", "Petty Cash Box", "Counter 2 Cash" |
| **Bank** | A savings or current bank account | "SBI Current A/c", "HDFC Business A/c", "ICICI Savings" |
| **UPI** | A UPI business ID that receives digital payments | "PhonePe Business", "Google Pay Store", "Paytm QR", "BHIM" |
| **Card Terminal** | A card swipe machine or POS terminal | "Pine Labs Terminal", "Razorpay Terminal", "Mswipe Counter 1" |
| **Wallet** | A digital wallet (non-UPI) | "Paytm Wallet", "Amazon Pay", "Freecharge" |
| **Other** | Anything that doesn't fit above | "Post-dated cheques holding", "Store credit float" |

### Why these six types?

A typical Indian kirana or retail store handles money through exactly these channels. Cash is universal. Bank accounts are used for supplier payments and large customer receipts. UPI has overtaken cards for small transactions since demonetisation. Card terminals exist in mid-to-large stores. Wallets are declining but still used. "Other" covers edge cases without forcing a schema change.

---

## 3. System accounts — auto-created

When a new store completes setup, the system automatically creates one payment account. This account cannot be deleted.

| Field | Value |
|-------|-------|
| Account Name | Cash Register |
| Account Type | Cash |
| is_system | true |
| is_default | true |
| is_active | true |
| Opening Balance | ₹0 |

**Why auto-create?**

Every kirana store has cash. The Cash Register account is the default payment method at POS — if the cashier doesn't explicitly choose a payment method, the system assumes cash. Without this default, the very first sale would fail because there is no payment destination.

The owner can rename this account (e.g. "Counter 1 Cash") but cannot delete it or change its type.

---

## 4. Data model — complete schema

```sql
-- Payment accounts: Cash, Bank, UPI, Card Terminal, Wallet, Other
payment_accounts (
  id                    INTEGER  PRIMARY KEY AUTOINCREMENT,
  guuid                 TEXT     NOT NULL UNIQUE,
  store_id              INTEGER  NOT NULL REFERENCES stores(id),

  -- Identity
  account_type          TEXT     NOT NULL,                  -- 'cash'|'bank'|'upi'|'card_terminal'|'wallet'|'other'
  name                  TEXT     NOT NULL,                  -- "SBI Current A/c", "PhonePe Business"
  description           TEXT,                               -- 0–250 chars, optional

  -- System flags
  is_system             INTEGER  NOT NULL DEFAULT 0,        -- 1 = auto-created, cannot delete
  is_default            INTEGER  NOT NULL DEFAULT 0,        -- 1 = default payment method at POS
  is_active             INTEGER  NOT NULL DEFAULT 1,        -- 0 = deactivated, hidden from POS

  -- Display
  display_order         INTEGER  NOT NULL DEFAULT 0,        -- sort position in POS picker

  -- Bank-type fields (populated only when account_type = 'bank')
  bank_name             TEXT,                               -- "State Bank of India"
  account_number        TEXT,                               -- masked in UI, stored encrypted
  ifsc_code             TEXT,                               -- 11-char Indian IFSC
  account_holder_name   TEXT,                               -- "Sharma Kirana Store"
  branch_name           TEXT,                               -- "Anna Nagar Branch"

  -- UPI-type fields (populated only when account_type = 'upi')
  upi_id                TEXT,                               -- "store@ybl", "9876543210@paytm"
  upi_provider          TEXT,                               -- 'phonepe'|'gpay'|'paytm'|'bhim'|'other'
  upi_linked_phone      TEXT,                               -- 10-digit phone linked to UPI

  -- Card Terminal-type fields (populated only when account_type = 'card_terminal')
  terminal_id           TEXT,                               -- terminal serial / ID
  terminal_provider     TEXT,                               -- 'pine_labs'|'razorpay'|'mswipe'|'paytm'|'other'
  terminal_merchant_id  TEXT,                               -- merchant ID from provider

  -- Wallet-type fields (populated only when account_type = 'wallet')
  wallet_provider       TEXT,                               -- 'paytm'|'amazon_pay'|'freecharge'|'other'
  wallet_linked_phone   TEXT,                               -- 10-digit phone linked to wallet

  -- Opening balance
  opening_balance_paise INTEGER  NOT NULL DEFAULT 0,        -- in paise, set once at creation

  -- Audit
  created_by_user_id    INTEGER  NOT NULL,
  modified_by_user_id   INTEGER,

  -- Sync
  row_version           INTEGER  NOT NULL DEFAULT 1,
  created_at            TEXT     NOT NULL,                  -- ISO 8601
  modified_at           TEXT     NOT NULL,                  -- ISO 8601
  deleted_at            TEXT,                               -- soft delete
  sync_status           TEXT     NOT NULL DEFAULT 'pending' -- 'pending'|'synced'|'conflict'
);

-- Indexes
CREATE UNIQUE INDEX payment_accounts_guuid_idx ON payment_accounts(guuid);
CREATE UNIQUE INDEX payment_accounts_store_name_uidx
  ON payment_accounts(store_id, name) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX payment_accounts_store_default_uidx
  ON payment_accounts(store_id)
  WHERE is_default = 1 AND deleted_at IS NULL;
CREATE INDEX payment_accounts_store_active_idx
  ON payment_accounts(store_id, is_active, display_order)
  WHERE deleted_at IS NULL;
CREATE INDEX payment_accounts_store_type_idx
  ON payment_accounts(store_id, account_type)
  WHERE deleted_at IS NULL;
CREATE INDEX payment_accounts_sync_idx
  ON payment_accounts(store_id, sync_status)
  WHERE sync_status = 'pending';
```

### Column design rationale

**Why type-specific columns instead of a separate table per type?**

A single table with nullable type-specific columns is simpler for offline sync (one entity to pull), for the POS payment picker (one query with type filter), and for the list screen (one query, group by type). The type-specific fields are a small set — a maximum of 5 per type. A polymorphic child table would add complexity for minimal gain.

**Why `opening_balance_paise` and not a running balance column?**

The running balance is derived, not stored. It equals `opening_balance_paise + SUM(all inflows) - SUM(all outflows)` from order_payments, supplier_payments, and cash_drawer_entries. Storing a running balance column would require updating it on every transaction and create race conditions in offline-first. Phase 1 shows the opening balance on the account detail; Phase 2 adds computed running balance from the ledger.

---

## 5. Field specifications — Common fields

These fields appear on EVERY account type.

### 5.1 Account Type

| Attribute | Value |
|-----------|-------|
| DB column | `account_type` |
| UI element | Radio group — 6 options |
| Required | Yes |
| Default | None — user must choose |
| Editable after save | No — locked permanently |
| Allowed values | `cash`, `bank`, `upi`, `card_terminal`, `wallet`, `other` |
| Form gate | Yes — all other fields are disabled until type is selected |

When the user selects a type, the form renders the type-specific fields below. Changing the type clears all type-specific fields and renders the new type's fields.

### 5.2 Account Name

| Attribute | Value |
|-----------|-------|
| DB column | `name` |
| UI element | Text input |
| Required | Yes |
| Max length | 100 characters |
| Character counter | Shown |
| Default | Suggested based on type (see below) |
| Editable after save | Yes |
| Uniqueness | Unique per store (case-insensitive, ignoring soft-deleted) |

**Auto-suggested names by type:**

| Type selected | Suggested name (editable) |
|--------------|--------------------------|
| Cash | "Cash Register" |
| Bank | "" (blank — user types bank name) |
| UPI | "" (blank — user types provider name) |
| Card Terminal | "Card Terminal" |
| Wallet | "" (blank) |
| Other | "" (blank) |

### 5.3 Description

| Attribute | Value |
|-----------|-------|
| DB column | `description` |
| UI element | Text area |
| Required | No |
| Max length | 250 characters |
| Character counter | Shown |
| Default | Empty |

### 5.4 Opening Balance

| Attribute | Value |
|-----------|-------|
| DB column | `opening_balance_paise` |
| UI element | Currency input (₹) |
| Required | No (defaults to ₹0) |
| Default | 0 |
| Min value | 0 (cannot be negative) |
| Format | en-IN locale with ₹ prefix (₹1,00,000 not ₹100,000) |
| Storage | INTEGER paise |
| Editable after save | No — set once at creation. If wrong, delete and recreate. |

### 5.5 Set as Default

| Attribute | Value |
|-----------|-------|
| DB column | `is_default` |
| UI element | Toggle switch |
| Required | No |
| Default | Off (unless this is the system Cash Register) |
| Behaviour | Only one account per store can be default. Enabling this disables the previous default. |
| Effect | Default account is pre-selected at POS checkout. Cashier can still change. |

### 5.6 Display Order

| Attribute | Value |
|-----------|-------|
| DB column | `display_order` |
| UI element | Not directly editable — determined by list drag-reorder (Phase 2) or creation order |
| Default | Next sequential number |
| Effect | Controls sort order in POS payment picker and list screen |

---

## 6. Field specifications — Bank-type fields

These fields appear ONLY when `account_type = 'bank'`.

### 6.1 Bank Name

| Attribute | Value |
|-----------|-------|
| DB column | `bank_name` |
| UI element | Searchable dropdown with common Indian banks + "Other" freetext |
| Required | Yes |
| Max length | 100 characters |

**Pre-populated banks:** SBI, HDFC, ICICI, Axis, Kotak Mahindra, Punjab National, Bank of Baroda, Union Bank, Canara Bank, Indian Bank, Bank of India, Central Bank, Indian Overseas Bank, UCO Bank, Bandhan Bank, IDFC First, Federal Bank, South Indian Bank, Karur Vysya Bank, City Union Bank, Other.

### 6.2 Account Number

| Attribute | Value |
|-----------|-------|
| DB column | `account_number` |
| UI element | Numeric input with masked display |
| Required | Yes |
| Length | 9–18 digits (Indian bank accounts vary) |
| Display format | Masked: show last 4 digits only (e.g. ****4521) |
| Storage | Full number stored (encrypted at rest on server) |
| Validation | Numeric only, 9–18 digits |

### 6.3 IFSC Code

| Attribute | Value |
|-----------|-------|
| DB column | `ifsc_code` |
| UI element | Uppercase text input |
| Required | Yes |
| Length | Exactly 11 characters |
| Format | 4 uppercase letters + `0` + 6 alphanumeric (e.g. SBIN0001234) |
| Validation | Regex: `^[A-Z]{4}0[A-Z0-9]{6}$` |
| Auto-capitalise | Yes — input converts to uppercase on blur |
| Error message | "Enter a valid 11-character IFSC code (e.g. SBIN0001234)" |

### 6.4 Account Holder Name

| Attribute | Value |
|-----------|-------|
| DB column | `account_holder_name` |
| UI element | Text input |
| Required | No |
| Max length | 100 characters |

### 6.5 Branch Name

| Attribute | Value |
|-----------|-------|
| DB column | `branch_name` |
| UI element | Text input |
| Required | No |
| Max length | 100 characters |

---

## 7. Field specifications — UPI-type fields

These fields appear ONLY when `account_type = 'upi'`.

### 7.1 UPI ID

| Attribute | Value |
|-----------|-------|
| DB column | `upi_id` |
| UI element | Text input with `@` hint |
| Required | Yes |
| Format | `<name>@<handle>` (e.g. `store@ybl`, `9876543210@paytm`, `shop.kumar@okaxis`) |
| Validation | Regex: `^[a-zA-Z0-9._-]+@[a-zA-Z][a-zA-Z0-9]*$` |
| Error message | "Enter a valid UPI ID (e.g. store@ybl)" |
| Max length | 50 characters |

### 7.2 UPI Provider

| Attribute | Value |
|-----------|-------|
| DB column | `upi_provider` |
| UI element | Single-select dropdown |
| Required | Yes |
| Options | PhonePe, Google Pay, Paytm, BHIM, Other |
| Default | None |

### 7.3 Linked Phone

| Attribute | Value |
|-----------|-------|
| DB column | `upi_linked_phone` |
| UI element | Phone input |
| Required | No |
| Format | 10-digit Indian mobile (no country code prefix) |
| Validation | Regex: `^[6-9]\d{9}$` |

---

## 8. Field specifications — Card Terminal-type fields

These fields appear ONLY when `account_type = 'card_terminal'`.

### 8.1 Terminal ID

| Attribute | Value |
|-----------|-------|
| DB column | `terminal_id` |
| UI element | Text input |
| Required | No |
| Max length | 50 characters |
| Example | "PL-4892", "TID-00184753" |

### 8.2 Terminal Provider

| Attribute | Value |
|-----------|-------|
| DB column | `terminal_provider` |
| UI element | Single-select dropdown |
| Required | Yes |
| Options | Pine Labs, Razorpay, Mswipe, Paytm, BharatPe, Other |
| Default | None |

### 8.3 Merchant ID

| Attribute | Value |
|-----------|-------|
| DB column | `terminal_merchant_id` |
| UI element | Text input |
| Required | No |
| Max length | 50 characters |

---

## 9. Field specifications — Wallet-type fields

These fields appear ONLY when `account_type = 'wallet'`.

### 9.1 Wallet Provider

| Attribute | Value |
|-----------|-------|
| DB column | `wallet_provider` |
| UI element | Single-select dropdown |
| Required | Yes |
| Options | Paytm, Amazon Pay, Freecharge, Other |
| Default | None |

### 9.2 Linked Phone

| Attribute | Value |
|-----------|-------|
| DB column | `wallet_linked_phone` |
| UI element | Phone input |
| Required | No |
| Format | 10-digit Indian mobile |
| Validation | Same as UPI linked phone |

---

## 10. Field specifications — Cash-type fields

Cash accounts have NO type-specific fields beyond the common fields. The account name and optional description are sufficient.

If the owner creates a second cash account (e.g. "Petty Cash Box"), it has the same structure as the system Cash Register — just without the `is_system` flag.

---

## 11. Field specifications — Other-type fields

Other accounts also have NO type-specific fields beyond the common fields. The name and description carry the context (e.g. name: "Post-Dated Cheques", description: "Holding account for cheques received but not yet deposited").

---

## 12. Form behaviour — how fields interact

### 12.1 Form gate — Account Type selection

Account Type acts as the form gate. Until the user selects a type, all fields below are disabled and the Save button is disabled.

```
User opens "Create Account"
  → Account Type: [Cash] [Bank] [UPI] [Card Terminal] [Wallet] [Other]
    All greyed out below.

User taps "Bank"
  → Common fields appear: Name, Description, Opening Balance, Set as Default
  → Bank fields appear below: Bank Name, Account Number, IFSC Code, Holder Name, Branch
  → Save button enables once all required fields are filled
```

### 12.2 Type change clears type-specific fields

If the user selects "Bank", fills bank fields, then switches to "UPI" before saving — all bank fields are cleared and UPI fields appear empty. An unsaved changes warning appears if any field had content.

### 12.3 Type locked after save

Once the account is saved, the Account Type radio group shows the selected type as a read-only badge. It cannot be changed. If the owner needs a different type, they must create a new account.

### 12.4 Opening Balance locked after save

Opening Balance is set once during creation. After save, it displays as read-only on the detail screen. If the opening balance was entered incorrectly, the owner must delete the account and recreate it (or use a Phase 2 balance adjustment).

### 12.5 Unsaved changes guard

If the user has entered any field and taps Back or navigates away, the system shows a confirmation dialog: "You have unsaved changes. Discard changes?" with "Discard" and "Keep Editing" options.

---

## 13. Account create flow

```
Step 1: Navigate to More → Accounts → Tap "+"
  ↓
Step 2: Select Account Type (form gate)
  [Cash] [Bank] [UPI] [Card Terminal] [Wallet] [Other]
  ↓
Step 3: Common fields appear + type-specific fields
  Name*           [_________________________]
  Description     [_________________________]
  Opening Balance [₹ 0                     ]
  Set as Default  [ Toggle ]
  --- Type-specific fields ---
  (e.g. Bank Name, IFSC, Account Number for Bank type)
  ↓
Step 4: Tap "Save"
  ↓
Step 5: Validation runs
  → All required fields filled?
  → Name unique within store?
  → IFSC format valid? (bank only)
  → UPI ID format valid? (upi only)
  → Account number length valid? (bank only)
  ↓ PASS                          ↓ FAIL
  Account saved                   Inline errors shown
  Toast: "Account created"        Save blocked
  Navigate to list screen         User corrects and retries
  ↓
  Account now appears in:
  - Accounts list screen
  - POS checkout payment picker
  - Supplier payment account picker
  - Customer payment collection picker
```

### Auto-generated ID

Accounts do NOT get a visible auto-generated ID like SA-001 or CUS-001. They are identified by their name in all UI. The `guuid` is the system identifier.

---

## 14. Account edit flow

| Field | Editable after save? |
|-------|---------------------|
| Account Type | No — permanently locked |
| Account Name | Yes |
| Description | Yes |
| Opening Balance | No — permanently locked |
| Set as Default | Yes |
| Bank Name | Yes |
| Account Number | Yes |
| IFSC Code | Yes |
| Account Holder Name | Yes |
| Branch Name | Yes |
| UPI ID | Yes |
| UPI Provider | Yes |
| Linked Phone (UPI/Wallet) | Yes |
| Terminal ID | Yes |
| Terminal Provider | Yes |
| Merchant ID | Yes |
| Wallet Provider | Yes |

**System account restrictions:** The system Cash Register can be renamed and its description changed. Its type (Cash), is_system flag, and is_default flag cannot be changed.

---

## 15. Account deactivate flow

Deactivation hides the account from the POS checkout picker and all payment selection screens without deleting it. Historical transactions that referenced this account are preserved.

| Attribute | Value |
|-----------|-------|
| UI element | Toggle on detail screen ("Active" toggle) |
| Who can deactivate | Owner, Manager |
| Effect | Account disappears from POS picker and all payment selectors |
| Reversible | Yes — toggle back to active |
| Blocked if | Account is the default AND is the only active account of its type |
| Blocked if | Account is the system Cash Register |

**Deactivation does NOT delete the account.** It remains in the accounts list with a "Deactivated" badge and can be reactivated at any time.

---

## 16. Account delete flow

| Attribute | Value |
|-----------|-------|
| Delete type | Soft delete (`deleted_at` timestamp) |
| Who can delete | Owner only |
| Confirmation | "Delete [Account Name]? This account will be removed from all payment selectors. Historical transactions will retain this account reference." with "Cancel" and "Delete" buttons |
| Blocked if | Account is the system Cash Register (`is_system = 1`) |
| Blocked if | Account is the current default (`is_default = 1`) — user must set another default first |

**What happens to existing transactions?**

Nothing. `order_payment`, `supplier_payment`, and `cash_drawer_entry` rows that reference this account by `guuid` remain intact. The account name is preserved in those records. Reports continue to show the deleted account's transactions grouped under its name.

**Reuse of names:** After soft deletion, the account name becomes available again for a new account (partial unique index filters `deleted_at IS NULL`).

---

## 17. Accounts list screen

### 17.1 Navigation

More tab → Accounts

### 17.2 Screen layout

```
┌─────────────────────────────────────┐
│  Accounts                      [+]  │
├─────────────────────────────────────┤
│  Filter: All | Cash | Bank | UPI |  │
│          Card | Wallet | Other      │
├─────────────────────────────────────┤
│  💰 Cash Register           Default │
│     Cash                            │
│     ₹0 opening balance             │
├─────────────────────────────────────┤
│  🏦 SBI Current Account            │
│     Bank · A/c ****4521            │
│     ₹45,000 opening balance        │
├─────────────────────────────────────┤
│  📱 PhonePe Business                │
│     UPI · store@ybl                │
│     ₹0 opening balance             │
├─────────────────────────────────────┤
│  📱 Google Pay Store                │
│     UPI · 9876543210@okaxis        │
│     ₹0 opening balance             │
├─────────────────────────────────────┤
│  💳 Pine Labs Terminal              │
│     Card Terminal · Pine Labs       │
│     ₹0 opening balance             │
├─────────────────────────────────────┤
│  ⛔ Paytm Wallet          Inactive │
│     Wallet · Paytm                  │
│     ₹500 opening balance           │
└─────────────────────────────────────┘
```

### 17.3 List row fields

| Element | Source | Display |
|---------|--------|---------|
| Icon | Derived from `account_type` | 💰 Cash, 🏦 Bank, 📱 UPI, 💳 Card, 👛 Wallet, 📋 Other |
| Account Name | `name` | Primary text |
| Subtitle line 1 | `account_type` + type-specific identifier | "Bank · A/c ****4521" or "UPI · store@ybl" or "Card Terminal · Pine Labs" |
| Subtitle line 2 | `opening_balance_paise` | "₹45,000 opening balance" |
| Default badge | `is_default = 1` | "Default" pill badge, right-aligned |
| Inactive badge | `is_active = 0` | "Inactive" pill badge, greyed row |

### 17.4 Type-specific subtitle content

| Account type | Subtitle shows |
|-------------|---------------|
| Cash | "Cash" (no additional identifier) |
| Bank | "Bank · A/c ****" + last 4 digits |
| UPI | "UPI · " + UPI ID |
| Card Terminal | "Card Terminal · " + provider name |
| Wallet | "Wallet · " + provider name |
| Other | "Other" (no additional identifier) |

### 17.5 Filter tabs

Tapping a filter tab shows only accounts of that type. "All" shows all types sorted by `display_order`. Deactivated accounts appear at the bottom of each group with reduced opacity.

### 17.6 Search

Search bar filters by account name (substring, case-insensitive). No search on type-specific fields.

### 17.7 Empty state

If no accounts exist (store setup did not run — edge case):

"No payment accounts yet. Tap + to add your first account."

---

## 18. Account detail screen

Tapping an account row opens the detail screen.

### 18.1 Header

- Account name (large)
- Account type badge (Cash / Bank / UPI / Card Terminal / Wallet / Other)
- Default badge (if applicable)
- Active/Inactive toggle (right side)
- Edit button (pencil icon, top right)
- More menu (⋮): Delete

### 18.2 Detail sections

**Section 1 — General**

| Label | Value |
|-------|-------|
| Account Type | Read-only badge |
| Account Name | Text |
| Description | Text (or "—" if empty) |
| Opening Balance | ₹ formatted |
| Default Account | Yes / No |

**Section 2 — Type-specific details** (only shown if fields have values)

For Bank:
| Label | Value |
|-------|-------|
| Bank Name | Text |
| Account Number | ****4521 (masked) |
| IFSC Code | SBIN0001234 |
| Account Holder | Text |
| Branch | Text |

For UPI:
| Label | Value |
|-------|-------|
| UPI ID | store@ybl |
| Provider | PhonePe |
| Linked Phone | 98765 43210 |

For Card Terminal:
| Label | Value |
|-------|-------|
| Terminal ID | PL-4892 |
| Provider | Pine Labs |
| Merchant ID | Text |

For Wallet:
| Label | Value |
|-------|-------|
| Provider | Paytm |
| Linked Phone | 98765 43210 |

**Section 3 — Transaction summary (Phase 2)**

In Phase 2, this section will show a summary of transactions routed through this account: total inflows, total outflows, computed balance. In Phase 1, this section is not shown.

---

## 19. Where accounts are used across the app

Payment accounts are referenced by other modules to record WHERE money flows. The account is not just a label — it is a foreign key reference.

| Module | How it uses accounts |
|--------|---------------------|
| **POS Checkout** | Cashier selects one or more accounts when collecting payment. `order_payment.payment_account_guuid` stores the reference. |
| **Supplier Payment** | When paying a supplier, the owner selects which account the money leaves from. The supplier balance ledger entry references the account. |
| **Customer Payment Collection** | When collecting outstanding balance, the owner selects which account the money arrives in. The customer credit ledger entry references the account. |
| **Cash Drawer Entry** | Safe drops, petty cash in/out, and supplier payments from the cash drawer reference the cash account. |
| **Shift Reconciliation** | End-of-shift cash count is reconciled against the system Cash Register account. |
| **Refunds** | Refund method maps to a payment account (cash refund → Cash Register, UPI refund → UPI account). |

### Integration with `order_payment`

The existing `order_payment` table currently has `paymentMethod VARCHAR(20)` (cash, upi, card, etc.). With the payment accounts module, a new column is added:

```sql
ALTER TABLE order_payment ADD COLUMN payment_account_guuid TEXT;
```

- For new orders, `payment_account_guuid` is populated from the cashier's selection at checkout.
- `paymentMethod` is still populated as a denormalized label (for display without joins).
- For historical orders (before accounts module), `payment_account_guuid` remains NULL.

---

## 20. POS checkout — payment method selection

### 20.1 Single payment flow (most common)

```
Customer total: ₹850
  ↓
Cashier taps "Collect Payment"
  ↓
Payment method picker appears:
  ┌───────────────────────────────┐
  │  How was this paid?           │
  │                               │
  │  💰 Cash Register    Default  │
  │  📱 PhonePe Business          │
  │  📱 Google Pay Store           │
  │  💳 Pine Labs Terminal         │
  │  🏦 SBI Current Account       │
  │                               │
  │  [Split Payment]              │
  └───────────────────────────────┘
  ↓
Cashier taps "PhonePe Business"
  ↓
Order completed:
  order_payment row:
    payment_method = 'upi'
    payment_account_guuid = <PhonePe guuid>
    amount_paise = 85000
```

### 20.2 Payment picker rules

- Only active accounts are shown (`is_active = 1`)
- Accounts are grouped by type: Cash first, then UPI, Card, Bank, Wallet, Other
- Within each group, sorted by `display_order`
- The default account is pre-highlighted (but not auto-selected)
- If only one account exists (Cash Register), it is auto-selected and the picker is skipped

---

## 21. Split payments — multi-account checkout

Split payment allows a single order to be paid across multiple accounts. This is common in Indian retail: customer pays ₹500 cash and ₹350 via UPI.

### 21.1 Split payment flow

```
Customer total: ₹850
  ↓
Cashier taps "Collect Payment" → taps "Split Payment"
  ↓
Split payment screen appears:
  ┌───────────────────────────────┐
  │  Split Payment         ₹850  │
  │  Remaining: ₹850              │
  │                               │
  │  + Add payment method         │
  │                               │
  │  [Complete]  (disabled)       │
  └───────────────────────────────┘
  ↓
Cashier taps "+ Add payment method"
  → Selects "Cash Register"
  → Enters ₹500
  ↓
  ┌───────────────────────────────┐
  │  Split Payment         ₹850  │
  │  Remaining: ₹350              │
  │                               │
  │  💰 Cash Register      ₹500  │
  │                          [✕]  │
  │                               │
  │  + Add payment method         │
  │                               │
  │  [Complete]  (disabled)       │
  └───────────────────────────────┘
  ↓
Cashier taps "+ Add payment method"
  → Selects "PhonePe Business"
  → Enters ₹350 (or taps "Remaining" to auto-fill ₹350)
  ↓
  ┌───────────────────────────────┐
  │  Split Payment         ₹850  │
  │  Remaining: ₹0     ✓ Exact   │
  │                               │
  │  💰 Cash Register      ₹500  │
  │  📱 PhonePe Business   ₹350  │
  │                               │
  │  [Complete]  (enabled)        │
  └───────────────────────────────┘
  ↓
Cashier taps "Complete"
  ↓
Two order_payment rows created:
  Row 1: method=cash,   account=Cash Register guuid, amount=50000
  Row 2: method=upi,    account=PhonePe guuid,       amount=35000
```

### 21.2 Split payment rules

| Rule | Detail |
|------|--------|
| Minimum splits | 2 (otherwise use single payment) |
| Maximum splits | 4 (practical limit — more becomes unusable) |
| Same account twice | Not allowed — each account can appear once |
| Sum must equal total | Complete button disabled until sum of splits = order total |
| Overpayment | Allowed ONLY on cash splits — excess becomes change due |
| Underpayment | Not allowed — remaining must be ₹0 |
| Cash tendered | Cash splits show tendered/change fields. Non-cash splits do not. |

---

## 22. System Cash Register — special account

| Rule | Detail |
|------|--------|
| Created | Automatically during store setup |
| `is_system` | 1 (true) |
| `is_default` | 1 (true) — can be changed if another default is set |
| Can rename | Yes |
| Can change type | No |
| Can deactivate | No |
| Can delete | No |
| Can change default | Yes — but only if another account is set as default first |
| Appears in list | Always — pinned to top of list |

If the owner creates a second cash account and wants it as default, they toggle "Set as Default" on the new account. The system Cash Register loses its default status but remains active and usable.

---

## 23. Account status lifecycle

```
                CREATE
                  │
                  v
             ┌──────────┐
             │  ACTIVE   │ ← initial state
             │           │
             │ Visible   │
             │ in POS    │
             │ picker    │
             └────┬──────┘
                  │ Owner toggles off
                  v
             ┌──────────┐
             │ INACTIVE  │
             │           │
             │ Hidden    │
             │ from POS  │
             │ picker    │
             └────┬──────┘
                  │ Owner toggles on
                  v
             ┌──────────┐
             │  ACTIVE   │ (restored)
             └────┬──────┘
                  │ Owner deletes
                  v
             ┌──────────┐
             │  DELETED  │ (soft)
             │           │
             │ Not shown │
             │ anywhere  │
             │ 7-year    │
             │ retention │
             └───────────┘
```

| Status | `is_active` | `deleted_at` | Visible in list | Visible in POS picker |
|--------|-------------|-------------|-----------------|----------------------|
| Active | 1 | NULL | Yes | Yes |
| Inactive | 0 | NULL | Yes (greyed, bottom) | No |
| Deleted | — | Timestamp | No | No |

---

## 24. RBAC — role-based access control

| Action | Owner | Manager | Cashier |
|--------|-------|---------|---------|
| View accounts list | Yes | Yes | No |
| View account detail | Yes | Yes | No |
| Create account | Yes | No | No |
| Edit account | Yes | No | No |
| Deactivate account | Yes | Yes | No |
| Delete account | Yes | No | No |
| Select account at POS checkout | Yes | Yes | Yes |
| Select account in split payment | Yes | Yes | Yes |

**Why cashiers cannot access the Accounts screen:**

Cashiers handle sales. They see payment accounts only in the POS checkout payment picker, where they select which account received the payment. They do not need to view bank details, IFSC codes, or UPI IDs. Exposing financial account details to cashier-level staff is a security risk.

**Why managers can deactivate but not create/edit/delete:**

A manager may need to temporarily disable a malfunctioning card terminal or a UPI account that is under maintenance. But creating accounts, modifying bank details, and deleting accounts are owner-level financial decisions.

---

## 25. Offline-first behaviour

| Scenario | Behaviour |
|----------|-----------|
| Create account while offline | Account saved to local SQLite. Appears immediately in list and POS picker. Syncs when connectivity returns. |
| Edit account while offline | Changes saved locally. Syncs when online. |
| Delete account while offline | Soft delete applied locally. Account disappears from list and picker. Sync propagates. |
| Select account at POS checkout while offline | Works normally — all accounts are in local DB. |
| Two devices create accounts with same name while offline | Sync conflict on name uniqueness. Server rejects the second. Conflict resolution prompts user to rename. |
| Default account changed on two devices while offline | Last-write-wins. The sync with the later `modified_at` timestamp takes precedence. |

---

## 26. Sync behaviour

### 26.1 Sync entity

| Property | Value |
|----------|-------|
| Entity type | `PaymentAccount` |
| Sync direction | Bidirectional |
| Conflict resolution | row_version optimistic concurrency |
| Tombstone on delete | Yes |
| Sync priority | HIGH — must arrive before any order_payment that references it |

### 26.2 Sync payload shape

```json
{
  "guuid": "a1b2c3d4-...",
  "store_id": "store-guuid",
  "account_type": "bank",
  "name": "SBI Current Account",
  "description": "Main business account",
  "is_system": false,
  "is_default": false,
  "is_active": true,
  "display_order": 2,
  "bank_name": "State Bank of India",
  "account_number_masked": "****4521",
  "ifsc_code": "SBIN0001234",
  "account_holder_name": "Sharma Kirana Store",
  "branch_name": "Anna Nagar Branch",
  "upi_id": null,
  "upi_provider": null,
  "upi_linked_phone": null,
  "terminal_id": null,
  "terminal_provider": null,
  "terminal_merchant_id": null,
  "wallet_provider": null,
  "wallet_linked_phone": null,
  "opening_balance_paise": 4500000,
  "row_version": 1,
  "created_at": "2026-06-25T10:30:00.000Z",
  "modified_at": "2026-06-25T10:30:00.000Z",
  "deleted_at": null,
  "created_by_user_id": "user-guuid"
}
```

**Sensitive field handling:** `account_number` is sent as masked (`****4521`) to client devices. The full account number is stored only on the server. The mobile app never stores or displays the full bank account number.

### 26.3 Sync dependency order

`payment_account` must sync BEFORE `order_payment` rows that reference it via `payment_account_guuid`. The sync engine's entity dependency graph places `PaymentAccount` ahead of `Order` and `OrderPayment`.

---

## 27. Business rules — complete list

| ID | Rule | Detail |
|----|------|--------|
| BR-PA-001 | One system Cash Register per store | Created during store setup. Cannot be deleted. Cannot change type. |
| BR-PA-002 | Exactly one default account per store | Setting a new default unsets the previous. Cannot have zero defaults if any active accounts exist. |
| BR-PA-003 | Account type locked after save | Type determines the field structure and cannot be changed. |
| BR-PA-004 | Opening balance locked after save | Set once at creation. Cannot be edited. |
| BR-PA-005 | Name unique per store | Case-insensitive, scoped to non-deleted accounts within the same store. |
| BR-PA-006 | Cannot delete system account | The system Cash Register (`is_system = 1`) cannot be soft-deleted by any role. |
| BR-PA-007 | Cannot delete default account | User must set another account as default before deleting the current default. |
| BR-PA-008 | Cannot deactivate system Cash Register | The system cash account must always be available. |
| BR-PA-009 | Cannot deactivate the only active account | At least one active account must exist at all times. |
| BR-PA-010 | Deactivated accounts hidden from POS picker | `is_active = 0` accounts do not appear in payment selection screens. |
| BR-PA-011 | Deleted accounts preserved in historical transactions | `order_payment` rows retain `payment_account_guuid`. Reports show the account name. |
| BR-PA-012 | POS picker auto-selects if only one account | If only one active account exists, the payment picker step is skipped. |
| BR-PA-013 | Split payment: 2–4 splits | Minimum 2, maximum 4 payment methods per order. |
| BR-PA-014 | Split payment: no duplicate accounts | Same account cannot appear twice in a split. |
| BR-PA-015 | Split payment: sum must equal total | The "Complete" button enables only when split amounts sum to the order total (or exceed for cash with change). |
| BR-PA-016 | Overpayment allowed only on cash | Non-cash splits cannot exceed the remaining amount. Cash splits can — excess is change due. |
| BR-PA-017 | Bank account number masked on device | Only last 4 digits shown. Full number stored server-side only. |
| BR-PA-018 | Soft delete with 7-year retention | GST audit compliance. `deleted_at` timestamp set, row retained. |

---

## 28. Validation matrix

| Field | Rule | Error message | Display |
|-------|------|---------------|---------|
| Account Type | Required | "Select an account type" | Inline |
| Account Name | Required | "Account name is required" | Inline |
| Account Name | Max 100 chars | "Account name cannot exceed 100 characters" | Inline |
| Account Name | Unique per store | "An account with this name already exists" | Inline |
| Description | Max 250 chars | "Description cannot exceed 250 characters" | Inline |
| Opening Balance | Min 0 | "Opening balance cannot be negative" | Inline |
| Bank Name | Required (bank type) | "Bank name is required" | Inline |
| Account Number | Required (bank type) | "Account number is required" | Inline |
| Account Number | 9–18 digits | "Account number must be 9 to 18 digits" | Inline |
| Account Number | Numeric only | "Account number must contain only digits" | Inline |
| IFSC Code | Required (bank type) | "IFSC code is required" | Inline |
| IFSC Code | Format: `^[A-Z]{4}0[A-Z0-9]{6}$` | "Enter a valid 11-character IFSC code (e.g. SBIN0001234)" | Inline |
| UPI ID | Required (UPI type) | "UPI ID is required" | Inline |
| UPI ID | Format: `^[a-zA-Z0-9._-]+@[a-zA-Z][a-zA-Z0-9]*$` | "Enter a valid UPI ID (e.g. store@ybl)" | Inline |
| UPI ID | Max 50 chars | "UPI ID cannot exceed 50 characters" | Inline |
| UPI Provider | Required (UPI type) | "Select a UPI provider" | Inline |
| Terminal Provider | Required (card_terminal type) | "Select a terminal provider" | Inline |
| Wallet Provider | Required (wallet type) | "Select a wallet provider" | Inline |
| Phone (UPI/Wallet) | Format: `^[6-9]\d{9}$` | "Enter a valid 10-digit Indian mobile number" | Inline |
| Delete system account | Blocked | "This is a system account and cannot be deleted" | Toast |
| Delete default account | Blocked | "Set another account as default before deleting this one" | Toast |
| Deactivate system account | Blocked | "The system Cash Register cannot be deactivated" | Toast |
| Deactivate last account | Blocked | "At least one active account must exist" | Toast |

---

## 29. Real-world scenarios

### Scenario 1: New store setup — Cash Register auto-created

Sharma opens the app for the first time, completes store setup (name, GSTIN, address). The system auto-creates a "Cash Register" account (`is_system=1, is_default=1, type=cash, opening_balance=0`). Sharma's first sale goes through with the Cash Register as the default payment method — no additional setup needed.

### Scenario 2: Owner adds PhonePe UPI

Sharma has a PhonePe Business QR at the counter. He goes to More → Accounts → taps "+". Selects "UPI". Enters name "PhonePe Business", UPI ID "sharma.kirana@ybl", provider "PhonePe", linked phone "9876543210". Taps Save. The account now appears in the POS checkout picker. Next time a customer scans the QR, the cashier selects "PhonePe Business" at checkout.

### Scenario 3: Split payment — ₹1,200 bill, customer pays part cash part UPI

Customer buys ₹1,200 worth of groceries. Hands over ₹700 cash and says "balance UPI pe kar deta hoon" (I'll pay the rest via UPI). Cashier taps "Split Payment" → adds Cash Register ₹700 → adds PhonePe ₹500 → taps Complete. Two `order_payment` rows created, each referencing the correct account.

### Scenario 4: Card terminal added when store grows

After 6 months, Sharma installs a Pine Labs card terminal. He creates a new Card Terminal account: name "Pine Labs Counter", provider "Pine Labs", terminal ID "PL-4892". Now card payments can be tracked separately. End-of-day reconciliation shows card transactions separate from cash and UPI.

### Scenario 5: Deactivating a broken terminal

The card terminal stops working. Manager deactivates the "Pine Labs Counter" account. It disappears from the POS picker so cashiers don't accidentally select it. When the terminal is repaired, the manager reactivates it.

---

## 30. Dos and don'ts

### Do:
- Create a separate account for each physical payment channel (each QR code, each terminal, each bank account)
- Use the default account for the most common payment method — saves cashier time at checkout
- Deactivate accounts temporarily instead of deleting them when payment channels are under maintenance
- Set meaningful names that the cashier can recognise quickly at checkout: "PhonePe Counter QR" is better than "UPI Account 2"

### Don't:
- Don't create one generic "UPI" account if you have both PhonePe and Google Pay — create separate accounts so you can reconcile each provider independently
- Don't enter ₹0 as opening balance and then manually adjust later — there is no balance adjustment in Phase 1, so set it correctly at creation
- Don't delete accounts to "clean up" — deactivate them instead, so historical transaction references remain intact
- Don't give cashiers access to the Accounts management screen — they only need to see the payment picker at checkout

---

## 31. Phase 2 — what is deferred

| Feature | Why deferred | Phase 2 scope |
|---------|-------------|---------------|
| Running account balance | Requires real-time aggregation of all transaction types (orders, refunds, supplier payments, drawer entries). Phase 1 shows opening balance only. | Computed balance from ledger entries on account detail screen. |
| Account-to-account transfers | Cash deposit to bank, bank withdrawal, etc. Needs its own transfer document. | Transfer screen with source account, destination account, amount, date, reference. |
| Bank API integration | Auto-fetching bank statement, balance via APIs (e.g. open banking). | Integration with bank aggregator APIs for real-time balance. |
| UPI settlement reconciliation | Matching UPI settlements from PhonePe/GPay merchant dashboard with POS records. | Import UPI settlement CSV and auto-match against order_payments. |
| Cheque lifecycle | Deposit → clearing → cleared / bounced tracking. | Status workflow on order_payment cheque entries. |
| Drag-and-drop account reordering | Manual sort order for POS picker. | Drag-reorder on accounts list screen. |
| Balance adjustment | Correcting opening balance or making manual adjustments. | Adjustment entries similar to stock adjustments but for account balances. |
| Account-level reports | Transaction history, daily summary, monthly trend per account. | Reports tab on account detail screen. |
| Multi-register cash accounts | Separate cash account per register (Counter 1, Counter 2). | Auto-link register ↔ cash account in shift session. |
| Payment gateway accounts | Razorpay, PayU, etc. for online order collection. | New account type `payment_gateway` with API keys and webhook config. |
