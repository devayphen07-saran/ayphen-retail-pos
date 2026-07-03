# Customers — Ayphen Retail Mobile

Complete reference for the Customers module. Every field, every flow, every business rule, every real-world scenario for Indian retail.

---

## Table of contents

1. [What this module does](#1-what-this-module-does)
2. [Customer types](#2-customer-types)
3. [Data model — complete schema](#3-data-model--complete-schema)
4. [Field specifications — General Information](#4-field-specifications--general-information)
5. [Field specifications — Contact and Communication](#5-field-specifications--contact-and-communication)
6. [Field specifications — Address](#6-field-specifications--address)
7. [Field specifications — Tax Registration](#7-field-specifications--tax-registration)
8. [Field specifications — Credit and Payment](#8-field-specifications--credit-and-payment)
9. [Field specifications — Relationship Fields](#9-field-specifications--relationship-fields)
10. [Field specifications — Contact Persons](#10-field-specifications--contact-persons)
11. [Field specifications — Notes and Attachments](#11-field-specifications--notes-and-attachments)
12. [Form behaviour — how fields interact](#12-form-behaviour--how-fields-interact)
13. [Customer create flow](#13-customer-create-flow)
14. [Customer edit flow](#14-customer-edit-flow)
15. [Customer delete flow](#15-customer-delete-flow)
16. [Customers list screen](#16-customers-list-screen)
17. [Customer detail screen](#17-customer-detail-screen)
18. [Walk-in Customer — special type](#18-walk-in-customer--special-type)
19. [Customer status lifecycle](#19-customer-status-lifecycle)
20. [RBAC — role-based access control](#20-rbac--role-based-access-control)
21. [Offline-first behaviour](#21-offline-first-behaviour)
22. [Sync behaviour](#22-sync-behaviour)
23. [Business rules — complete list](#23-business-rules--complete-list)
24. [Validation matrix](#24-validation-matrix)
25. [Real-world scenarios](#25-real-world-scenarios)
26. [Dos and don'ts](#26-dos-and-donts)

---

## 1. What this module does

The Customers module manages buyers — the people and businesses that purchase from the store. In a kirana or retail context, a customer is anyone who shops regularly enough to have a named account, a credit line, or a purchase history tracked against them.

**What it enables:**
- Owner creates customer profiles for account customers (credit-based buyers)
- Credit limit enforced at point of sale — cashier cannot sell beyond the customer's approved credit
- GSTIN stored for B2B customers so invoices are GST-compliant
- Birthday and anniversary stored for relationship management (Diwali discount, birthday offer)
- Walk-in Customer handles anonymous cash sales without requiring a customer record
- Outstanding balance visible on the customer detail so the owner can chase payments

**What it does not do:**
- No customer portal (self-service invoice viewing)
- No CRM workflows or automated follow-ups
- No loyalty points (Phase 2)
- No multi-currency (INR only)
- No customer-facing statements or aging reports (Phase 2)
- No product pricing rules per customer (Phase 2)

---

## 2. Customer types

### 2.1 Regular Customer (Account Customer)

A named individual or business with whom the store has an ongoing relationship. Can be given credit. Appears in the POS customer picker during checkout. Most customers in a kirana store fall into this category.

```
Examples: Sharma Ji (neighbour, monthly tab), XYZ Restaurant (B2B account),
          Priya (regular buyer, birthday discounts)
```

---

### 2.2 Cash Customer

A named customer who always pays cash — no credit, no outstanding balance. Still useful to track purchase history and contact details.

```
Examples: Occasional buyers the owner knows personally but who always pay cash
```

**Billing type = Cash → Payment terms forced to "Due on Receipt" and locked.**

---

### 2.3 Walk-in Customer (System customer)

A special system-generated customer used for anonymous cash sales where the buyer's identity is not recorded. Created automatically when the store is set up. Cannot be edited or deleted.

Full specification in [Section 18](#18-walk-in-customer--special-type).

```
Examples: Any cash sale where the cashier does not capture customer details
          — typical for 80% of transactions in a kirana store
```

---

## 3. Data model — complete schema

```sql
-- Core customer table
customers (
  id                      INTEGER  PRIMARY KEY AUTOINCREMENT,
  guuid                   TEXT     NOT NULL UNIQUE,         -- UUID v4, global ID
  store_id                INTEGER  NOT NULL REFERENCES stores(id),

  -- Identity
  customer_id             TEXT     NOT NULL,               -- auto-generated: CUS-001
  name                    TEXT     NOT NULL,               -- 3–100 chars
  customer_type           TEXT     NOT NULL DEFAULT 'regular', -- 'regular'|'cash'|'walkin'
  logo_uri                TEXT,

  -- Contact
  phone                   TEXT,                            -- 10-digit Indian mobile
  email                   TEXT,                            -- unique per store
  website                 TEXT,

  -- Tax (Indian B2B)
  gstin                   TEXT,                            -- 15-char GSTIN
  pan_number              TEXT,                            -- 10-char PAN

  -- Credit and payment
  credit_limit_paise      INTEGER  DEFAULT 0,              -- 0 = no limit
  override_credit_limit   INTEGER  NOT NULL DEFAULT 0,     -- 1 = allow override
  payment_term_lookup_fk  INTEGER  REFERENCES lookups(id),
  payment_term_days       INTEGER,

  -- Address (primary — denormalised)
  address_line_1          TEXT,
  address_line_2          TEXT,
  city                    TEXT,
  district                TEXT,
  state                   TEXT,
  pin_code                TEXT,

  -- Relationship management (Indian retail)
  birthday                TEXT,                            -- ISO date YYYY-MM-DD
  anniversary             TEXT,                            -- ISO date YYYY-MM-DD

  -- Status
  is_active               INTEGER  NOT NULL DEFAULT 1,

  -- Notes
  notes                   TEXT,                            -- 0–250 chars

  -- Sync
  created_at              TEXT     NOT NULL,
  updated_at              TEXT     NOT NULL,
  deleted_at              TEXT,                            -- soft delete
  sync_status             TEXT     NOT NULL DEFAULT 'pending'
)

-- Customer contact persons
customer_contacts (
  id                      INTEGER  PRIMARY KEY AUTOINCREMENT,
  guuid                   TEXT     NOT NULL UNIQUE,
  customer_guuid          TEXT     NOT NULL REFERENCES customers(guuid),
  store_id                INTEGER  NOT NULL,
  name                    TEXT     NOT NULL,
  designation             TEXT,
  phone                   TEXT,
  email                   TEXT,
  is_primary              INTEGER  NOT NULL DEFAULT 0,
  created_at              TEXT     NOT NULL,
  sync_status             TEXT     NOT NULL DEFAULT 'pending'
)

-- Customer attachments
customer_attachments (
  id                      INTEGER  PRIMARY KEY AUTOINCREMENT,
  guuid                   TEXT     NOT NULL UNIQUE,
  customer_guuid          TEXT     NOT NULL REFERENCES customers(guuid),
  store_id                INTEGER  NOT NULL,
  file_name               TEXT     NOT NULL,
  file_uri                TEXT     NOT NULL,
  file_type               TEXT     NOT NULL,
  file_size_bytes         INTEGER  NOT NULL,
  created_at              TEXT     NOT NULL,
  sync_status             TEXT     NOT NULL DEFAULT 'pending'
)
```

---

## 4. Field specifications — General Information

### 4.1 Customer Name

| Attribute | Value |
|-----------|-------|
| Type | Text input |
| Mandatory | Yes |
| Min length | 3 characters |
| Max length | 100 characters |
| Uniqueness | Per store (case-insensitive) |
| Stored as | `name TEXT` |

**The form gate:** Until a valid name (3+ characters) is entered, all other fields are disabled. If the name is cleared after fields are filled, they all disable again but retain their values.

**Validation:**
```
Required            → "Customer name is required"
< 3 chars           → "Name must be at least 3 characters"
> 100 chars         → "Name cannot exceed 100 characters"
Duplicate in store  → "A customer with this name already exists"
Whitespace only     → "Name cannot be blank"
```

---

### 4.2 Customer ID

| Attribute | Value |
|-----------|-------|
| Type | Auto-generated display field |
| Format | Prefix + sequential number (CUS-001, CUS-002) |
| Prefix | Configurable from store settings (default: "CUS") |
| Uniqueness | Per store, permanent |
| Editable | Never — always read-only |
| Stored as | `customer_id TEXT` |

Never reused after deletion. Historical sales orders referencing CUS-042 must always resolve to the same customer.

---

### 4.3 Customer Type

| Attribute | Value |
|-----------|-------|
| Type | Segmented control / radio |
| Options | Regular / Cash |
| Default | Regular |
| Locked after save | YES |
| Stored as | `customer_type TEXT` |

**Walk-in** type is system-only — not selectable by users.

**Why locked:** Customer type determines credit availability, payment terms, and which dropdowns the customer appears in. Changing type after creation would silently change outstanding balance treatment and reporting.

---

### 4.4 Customer Logo / Avatar

| Attribute | Value |
|-----------|-------|
| Type | Image picker |
| Mandatory | No |
| Formats | JPG, JPEG, PNG |
| Max size | 1 MB |
| Stored as | `logo_uri TEXT` |

Falls back to initials avatar (first 2 characters of name) with a deterministic colour if no logo is uploaded.

---

### 4.5 Active Toggle

| Attribute | Value |
|-----------|-------|
| Default | ON (disabled during creation) |
| Editable | Only in edit mode |
| Stored as | `is_active INTEGER` |

During creation: always ON and greyed out. In edit mode: interactive. Deactivating removes customer from POS picker and all transaction dropdowns. Existing sales are preserved.

---

## 5. Field specifications — Contact and Communication

### 5.1 Phone Number

| Attribute | Value |
|-----------|-------|
| Type | Numeric text input |
| Mandatory | No |
| Format | 10-digit Indian mobile (+91 fixed) |
| Stored as | `phone TEXT` |

**Validation:**
```
Not 10-digit Indian format → "Enter a valid Indian phone number"
```

---

### 5.2 Email

| Attribute | Value |
|-----------|-------|
| Type | Email input |
| Mandatory | No |
| Max length | 255 characters |
| Uniqueness | Per store (case-insensitive) |
| Stored as | `email TEXT` |

**Validation:**
```
Invalid format          → "Enter a valid email address"
Duplicate in store      → "This email is already used by another customer"
```

---

### 5.3 Website

| Attribute | Value |
|-----------|-------|
| Type | Text input (URL) |
| Mandatory | No |
| Stored as | `website TEXT` |

Relevant for B2B customers (restaurants, hotels, caterers) who have business websites.

---

## 6. Field specifications — Address

Indian address hierarchy: **State → District → City → PIN Code**

### 6.1 Address Line 1 and 2

| Attribute | Value |
|-----------|-------|
| Type | Text input |
| Mandatory | No |
| Max length | 100 characters each |

---

### 6.2 City / Town

| Attribute | Value |
|-----------|-------|
| Type | Text input |
| Mandatory | No |
| Min length | 2 characters |
| Max length | 50 characters |

---

### 6.3 District

| Attribute | Value |
|-----------|-------|
| Type | Dropdown or text entry |
| Source | Dependent on state |
| Stored as | `district TEXT` |

---

### 6.4 State

| Attribute | Value |
|-----------|-------|
| Type | Dropdown |
| Source | 28 Indian states + 8 Union Territories |
| Stored as | `state TEXT` |

Changing state clears district and city.

---

### 6.5 PIN Code

| Attribute | Value |
|-----------|-------|
| Type | Numeric text |
| Format | Exactly 6 digits |
| Stored as | `pin_code TEXT` |

**Validation:**
```
Not 6 digits → "PIN code must be 6 digits"
Non-numeric  → "PIN code must contain only digits"
```

---

## 7. Field specifications — Tax Registration

### 7.1 GSTIN

| Attribute | Value |
|-----------|-------|
| Type | Text input |
| Mandatory | No |
| Format | 15 characters |
| Stored as | `gstin TEXT` |

Required for B2B customers who need a GST invoice (restaurants, hotels, businesses). Without a valid GSTIN, the sale can only be recorded as B2C (no ITC for the customer).

**Format:**
```
Regex: ^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$
Error: "Enter a valid 15-character GSTIN"
```

---

### 7.2 PAN

| Attribute | Value |
|-----------|-------|
| Type | Text input |
| Mandatory | No |
| Format | 10 characters: AAAAA0000A |
| Stored as | `pan_number TEXT` |

Required for high-value transactions subject to TDS. Also auto-extracted from GSTIN if GSTIN is entered first.

---

## 8. Field specifications — Credit and Payment

### 8.1 Credit Limit

| Attribute | Value |
|-----------|-------|
| Type | Numeric (stored as paise) |
| Mandatory | No |
| Default | 0 (no limit) |
| Min value | 0 |
| Stored as | `credit_limit_paise INTEGER` |

**Enforcement at POS:** When a credit customer is selected at checkout, the cashier sees their outstanding balance. If adding this sale would exceed the credit limit, the POS shows a warning:

```
"Adding ₹850 would exceed Sharma Ji's credit limit of ₹2,000.
 Current outstanding: ₹1,400. Available credit: ₹600."
```

**Override:** Owner and Manager roles can override the credit limit warning and proceed. Cashier role cannot override.

**0 = no limit:** A credit limit of ₹0 means no limit is enforced. Unlimited credit. This is the default.

---

### 8.2 Override Credit Limit

| Attribute | Value |
|-----------|-------|
| Type | Toggle |
| Default | OFF |
| Stored as | `override_credit_limit INTEGER` |

When ON, sales can exceed the credit limit without the warning appearing. Useful for VIP customers or business accounts with established trust.

---

### 8.3 Payment Terms

| Attribute | Value |
|-----------|-------|
| Type | Dropdown |
| Source | `lookups` table, type = PAYMENT_TERM |
| Default | From store settings |
| Stored as | `payment_term_lookup_fk INTEGER` |

**Same terms as Suppliers module:**

| Term | Meaning |
|------|---------|
| Cash | Immediate payment |
| Net 7 / 15 / 30 / 60 | Pay within N days |
| Net (custom) | User-defined days (1–999) |
| End of Month | Pay by end of month |
| Due on Receipt | Immediate (same as Cash) |

**Cash customer type → Due on Receipt forced:** When `customer_type = 'cash'`, payment terms are auto-set to "Due on Receipt" and the field is disabled.

---

### 8.4 Payment Term Days

| Attribute | Value |
|-----------|-------|
| Type | Integer |
| Mandatory | Yes when Payment Term = "Net (custom)" |
| Range | 1–999 |

---

## 9. Field specifications — Relationship Fields

These fields are specific to Indian retail relationship management. A kirana store owner knows their customers personally and leverages festivals and personal occasions for customer retention.

### 9.1 Birthday

| Attribute | Value |
|-----------|-------|
| Type | Date picker |
| Mandatory | No |
| Format | DD/MM (day and month only — year optional for privacy) |
| Stored as | `birthday TEXT` — ISO format YYYY-MM-DD (year = 1900 if not provided) |

**Use case:** App can surface "Customers with birthdays this week" on the Home screen. Owner can call them, offer a birthday discount.

---

### 9.2 Anniversary

| Attribute | Value |
|-----------|-------|
| Type | Date picker |
| Mandatory | No |
| Format | DD/MM |
| Stored as | `anniversary TEXT` |

**Use case:** Wedding anniversary is significant in Indian culture. Grocery stores often reach out to loyal customers around anniversaries.

---

## 10. Field specifications — Contact Persons

For B2B customers (restaurants, hotels, offices), there are often multiple contact people. Same structure as Suppliers.

### 10.1 Contact Name

| Attribute | Value |
|-----------|-------|
| Type | Text input |
| Mandatory | Yes per contact row |
| Min length | 3 characters |
| Max length | 100 characters |

---

### 10.2 Designation

| Attribute | Value |
|-----------|-------|
| Type | Text input |
| Mandatory | No |
| Max length | 50 characters |

Example: "Head Chef", "Purchase Manager", "Owner".

---

### 10.3 Phone and Email

Same specs as Supplier contact persons. Contact person emails not checked for uniqueness.

---

### 10.4 Primary Contact

Only one primary contact per customer. Marking a new contact as primary auto-clears the previous one.

---

## 11. Field specifications — Notes and Attachments

### 11.1 Notes

| Attribute | Value |
|-----------|-------|
| Type | Text area |
| Mandatory | No |
| Max length | 250 characters |

Examples: "Prefers delivery between 9–11 AM", "Allergic to specific products", "10% Diwali discount agreed", "Pays by cheque only".

---

### 11.2 Attachments

| Attribute | Value |
|-----------|-------|
| Type | File picker |
| Max files | 10 per customer |
| Max size | 1 MB per file |
| Formats | PDF, JPG, PNG, DOC, DOCX |

Examples: signed credit agreement, customer's FSSAI licence (for B2B food businesses), ID proof for large credit customers.

---

## 12. Form behaviour — how fields interact

### 12.1 The form gate

```
name.length < 3 → ALL fields disabled
name.length >= 3 → Fields enable
Name cleared after filling → Fields disable, values retained
```

---

### 12.2 Customer type drives payment terms

```
Customer type = Cash
  → Payment terms auto-set to "Due on Receipt"
  → Payment terms field DISABLED
  → Credit limit field HIDDEN (cash customers have no credit)

Customer type = Regular
  → Payment terms and credit limit fields visible and editable
```

---

### 12.3 GSTIN extracts PAN

```
GSTIN entered (e.g., 33AAPFU0939F1Z5)
PAN field is empty
  → PAN auto-fills: AAPFU0939F (characters 3–12 of GSTIN)
  → Toast: "PAN auto-filled from GSTIN"
```

---

### 12.4 State drives district

```
State selected → District options populate
State cleared  → District clears, City clears
```

---

### 12.5 Credit limit = 0 means no limit

```
credit_limit_paise = 0
  → No enforcement at POS
  → Customer effectively has unlimited credit

credit_limit_paise > 0
  → Enforcement active at POS
  → Warning shown when sale would exceed limit
```

---

### 12.6 Override credit limit flag

```
override_credit_limit = 1
  → POS skips the credit limit check entirely
  → No warning shown regardless of balance
  → Use for VIP accounts

override_credit_limit = 0 (default)
  → Normal enforcement
```

---

## 13. Customer create flow

```
Owner opens More → Customers → taps "+"
    ↓
CustomerCreateScreen opens as modal
app/(store)/(main)/(tabs)/more/customers/create.tsx
→ features/customers/screens/CustomerCreateScreen.tsx
    ↓
Step 1: Enter customer name (3+ chars) → form enables
Step 2: Select customer type (Regular or Cash)
Step 3: Configure contact, address, tax, credit, payment, notes
    ↓
Taps "Save"
    ↓
Validation:
  - Name uniqueness
  - Email uniqueness (if entered)
  - GSTIN format
  - PAN format and GSTIN match
  - Phone format
  - PIN code 6 digits
  - Credit limit non-negative
  - Payment term days if Net custom
    ↓
If validation passes:
  - Customer written to local SQLite (sync_status = 'pending')
  - customer_id generated (CUS-001, etc.)
  - router.dismiss()
  - Customers list refreshes
  - Success toast: "Customer created"
```

---

### 13.1 Unsaved changes guard

```
Form is dirty + owner tries to dismiss
→ Alert: "Discard changes?"
  Cancel  → stay on form
  Discard → dismiss, changes lost
```

---

## 14. Customer edit flow

```
Owner taps Edit on a customer
    ↓
CustomerEditScreen opens as modal
    ↓
Locked fields (read-only):
  - Customer ID
  - Customer Type (locked after save)
    ↓
All other fields editable
    ↓
Save → local SQLite updated → sync queued
router.dismiss()
Success toast: "Customer updated"
```

**Changes affect future transactions only.** Existing sales orders retain the customer details as they were at transaction time.

---

## 15. Customer delete flow

### 15.1 Delete checks

```
Check 1: Does the customer have any sales transactions?
  → Any sale, order, or payment linked
  → Error: "Cannot delete. This customer has purchase history."

Check 2: Does the customer have an outstanding balance?
  → outstanding_balance_paise > 0
  → Error: "Cannot delete. This customer has an outstanding balance of ₹X."

If all pass:
  → Confirmation: "Delete [Customer Name]? This cannot be undone."
  → Confirms
  → Soft delete: deleted_at = NOW()
  → Customer ID permanently retired
  → Sync engine sends delete
```

---

### 15.2 Deactivate vs Delete

| Action | Sales history | Reversible | POS picker | Outstanding balance |
|--------|--------------|------------|------------|---------------------|
| Deactivate | Preserved | Yes | Removed | Preserved |
| Delete | Blocks if any | No | Removed | Must be zero |

---

## 16. Customers list screen

### 16.1 Screen structure

```
Route:   app/(store)/(main)/(tabs)/more/customers/index.tsx
Feature: features/customers/screens/CustomerListScreen.tsx
Stack:   Inside more/ Stack — tab bar HIDDEN
```

### 16.2 Header

- Title: "Customers"
- Right: "+" button (requires Customer.create permission)

### 16.3 Search bar

Searches: customer name, phone, email, customer ID, GSTIN. Debounced 200ms.

### 16.4 Status filter chips

```
All      — active + inactive
Active   — only is_active = 1
Inactive — only is_active = 0
```

Default: Active.

### 16.5 Customer list row

Each row shows:
- Avatar (first 2 chars of name, deterministic colour — no two customers in the list should share colour)
- Customer name + Customer ID below
- Phone or email
- Outstanding balance (if > 0, shown in amber/red depending on whether overdue)
- Payment terms badge
- Chevron → customer detail

### 16.6 Swipe actions

```
Swipe left:
  [Edit — primary colour] → CustomerEditScreen modal
  [Delete — red]          → delete flow with checks
```

---

## 17. Customer detail screen

```
Route:   app/(store)/(main)/(tabs)/more/customers/[guuid]/index.tsx
Feature: features/customers/screens/CustomerDetailScreen.tsx
Stack:   Inside more/ Stack — tab bar HIDDEN
```

**Sections:**
- Header: avatar/logo, name, customer ID, status badge, customer type badge
- Contact: phone, email, website
- Tax: GSTIN (masked for cashier), PAN (masked for cashier)
- Credit: limit, outstanding balance, payment terms
- Relationship: birthday, anniversary
- Address: full Indian address
- Contact persons
- Notes and attachments
- Purchase history (Phase 2 placeholder)

**Header right:**
- Edit (requires Customer.edit permission)
- Deactivate / Activate toggle
- Delete (requires Customer.delete permission)

**Outstanding balance display:**

```
₹0               → green "No outstanding"
₹1 – limit       → amber "₹X outstanding"
> limit           → red "₹X outstanding — exceeds credit limit"
```

---

## 18. Walk-in Customer — special type

### 18.1 What it is

Walk-in Customer is a system-generated customer record that represents all anonymous cash sales — buyers who pay cash and do not want (or need) their details recorded. It is the most-used "customer" in a typical kirana store.

**Created automatically** when the store is set up. There is exactly one Walk-in Customer per store. It cannot be edited, deactivated, or deleted.

### 18.2 How it works

```
Cashier scans items at POS
Customer picker: shows "Walk-in Customer" as default
Cashier taps Checkout
→ Sale completed under Walk-in Customer
→ No customer profile created
→ Sale aggregated with all other walk-in sales
→ No outstanding balance tracking
```

**Walk-in is the default customer at POS.** The cashier only needs to change this when the buyer is a named account customer.

### 18.3 Walk-in rules

| Feature | Walk-in Customer |
|---------|-----------------|
| Visible in Customers list | No — hidden from list |
| Visible in POS customer picker | Yes — default selection |
| Editable | No — system-managed |
| Deletable | No — system-managed |
| Credit tracking | No |
| Payment terms | Cash / Due on Receipt (fixed) |
| Can be used for credit sales | No |
| Can be used for invoices requiring GSTIN | No |

### 18.4 Walk-in schema

```sql
-- Created automatically at store setup
INSERT INTO customers (
  guuid, store_id, customer_id, name,
  customer_type, is_active, created_at, updated_at
) VALUES (
  uuid_v4(), [store_id], 'WALKIN',
  'Walk-in Customer', 'walkin', 1,
  NOW(), NOW()
);
```

`customer_type = 'walkin'` is the flag that identifies this special record. It is excluded from all list queries (`WHERE customer_type != 'walkin'`) but included in POS picker queries (`WHERE customer_type = 'walkin' OR is_active = 1`).

### 18.5 Walk-in in daily reporting

The Home screen shows today's sales split:
- Total walk-in sales: ₹12,450 (35 transactions)
- Total account sales: ₹8,200 (8 transactions)

This helps the owner understand the cash-to-credit ratio of their daily business.

---

## 19. Customer status lifecycle

```
NEW → (valid save) → ACTIVE
ACTIVE → (deactivate) → INACTIVE
INACTIVE → (activate) → ACTIVE
ACTIVE or INACTIVE → (delete, no transactions + no balance) → DELETED (terminal)
```

### 19.1 Deactivation rules

**Deactivation is blocked when the customer has open transactions or an outstanding balance.**

Unlike suppliers (where deactivation is always allowed), a customer with an outstanding balance cannot be deactivated. The owner must either:
1. Collect the payment and clear the balance
2. Write off the balance (Phase 2)
3. Keep the customer active until the account is cleared

```
Attempt to deactivate with outstanding balance:
→ Error: "Cannot deactivate. [Customer Name] has an outstanding balance of ₹X.
          Collect payment before deactivating."
```

### 19.2 Status feature matrix

| Feature | ACTIVE | INACTIVE |
|---------|--------|----------|
| View details | ✅ | ✅ |
| Edit details | ✅ | ✅ |
| Select at POS | ✅ | ❌ |
| New sale/invoice | ✅ | ❌ |
| Appears in credit reports | ✅ | ✅ (historical) |
| Delete | ✅ (if no transactions) | ✅ (if no transactions) |

---

## 20. RBAC — role-based access control

### 20.1 Permission matrix

| Action | Owner | Manager | Cashier |
|--------|-------|---------|---------|
| View customer list | ✅ | ✅ | ✅ |
| View customer detail | ✅ | ✅ | ✅ |
| Create customer | ✅ | ✅ | ❌ |
| Edit customer | ✅ | ✅ | ❌ |
| Deactivate customer | ✅ | ✅ | ❌ |
| Delete customer | ✅ | ❌ | ❌ |
| View GSTIN / PAN | ✅ | ✅ | ❌ |
| View credit limit | ✅ | ✅ | ✅ (at POS only) |
| Override credit limit at POS | ✅ | ✅ | ❌ |
| View outstanding balance | ✅ | ✅ | ✅ (at POS, masked) |

### 20.2 Enforcement layers

**Layer 1 — POS customer picker**

All active customers (including Walk-in) are available to all roles. Credit limit warning shown to cashier but override requires manager/owner.

**Layer 2 — Customers list and detail**

- No "+" button if no create permission
- No edit button if no edit permission
- GSTIN and PAN masked (`33XXXXX939F1Z5`) for cashier role
- Outstanding balance shown at POS as colour-coded indicator (green/amber/red) without the rupee amount for cashier

**Layer 3 — Delete protection**

Delete option completely hidden from cashier and manager roles. Even in kebab menus.

---

## 21. Offline-first behaviour

| Operation | Offline |
|-----------|---------|
| View customer list | ✅ Reads from local SQLite |
| Search customers | ✅ Reads from local SQLite |
| POS customer picker | ✅ All from local SQLite |
| Credit limit check at POS | ✅ Uses local outstanding balance |
| Create customer | ✅ Saved locally, queued |
| Edit customer | ✅ Saved locally, queued |
| Deactivate customer | ✅ Updated locally, queued |
| Delete customer | ✅ Soft-deleted locally, queued |
| GSTIN validation | ✅ Regex runs offline |

**Credit limit offline:** The outstanding balance used for credit limit checks is calculated from local SQLite. If a customer has made payments on another device that have not yet synced, the local balance may be stale. This is an acceptable limitation of offline-first. The balance reconciles when sync completes.

---

## 22. Sync behaviour

### 22.1 Sync payload

```typescript
toSyncShape(customer: CustomerRow): CustomerSyncPayload {
  return {
    guuid:                    customer.guuid,
    customer_id:              customer.customer_id,
    name:                     customer.name,
    customer_type:            customer.customer_type,
    phone:                    customer.phone,
    email:                    customer.email,
    gstin:                    customer.gstin,
    pan_number:               customer.pan_number,
    credit_limit_paise:       customer.credit_limit_paise,
    override_credit_limit:    customer.override_credit_limit,
    payment_term_lookup_fk:   customer.payment_term_lookup_fk,
    payment_term_days:        customer.payment_term_days,
    address_line_1:           customer.address_line_1,
    address_line_2:           customer.address_line_2,
    city:                     customer.city,
    district:                 customer.district,
    state:                    customer.state,
    pin_code:                 customer.pin_code,
    birthday:                 customer.birthday,
    anniversary:              customer.anniversary,
    is_active:                customer.is_active,
    notes:                    customer.notes,
    deleted_at:               customer.deleted_at,
  };
}
```

### 22.2 Walk-in Customer sync

Walk-in Customer is created by the server during store setup and pushed to all devices in the initial bootstrap sync. The client never creates or modifies this record — it is server-authoritative.

---

## 23. Business rules — complete list

### Identity

| Rule | Description |
|------|-------------|
| BR-CUS-001 | Customer name mandatory, 3–100 chars, unique per store (case-insensitive) |
| BR-CUS-002 | All form fields disabled until name has 3+ valid characters |
| BR-CUS-003 | Customer ID auto-generated, never manually editable, never reused |
| BR-CUS-004 | Email unique per store (case-insensitive) |
| BR-CUS-005 | Customer type locked after creation |

### Walk-in

| Rule | Description |
|------|-------------|
| BR-CUS-010 | One Walk-in Customer per store, auto-created at store setup |
| BR-CUS-011 | Walk-in Customer hidden from all customer list screens |
| BR-CUS-012 | Walk-in Customer is the default customer at POS for cash sales |
| BR-CUS-013 | Walk-in Customer cannot be edited, deactivated, or deleted |
| BR-CUS-014 | Walk-in Customer has no credit tracking |

### Credit

| Rule | Description |
|------|-------------|
| BR-CUS-020 | Credit limit 0 means no enforcement (unlimited) |
| BR-CUS-021 | Credit limit stored in paise (integer) |
| BR-CUS-022 | POS shows warning when sale would exceed credit limit |
| BR-CUS-023 | Owner and Manager can override credit limit warning |
| BR-CUS-024 | Cashier cannot override credit limit |
| BR-CUS-025 | override_credit_limit = 1 disables the POS warning entirely |

### Payment

| Rule | Description |
|------|-------------|
| BR-CUS-030 | Cash customer type → payment terms forced to Due on Receipt and disabled |
| BR-CUS-031 | Payment term days required when payment term = Net (custom) |

### Tax

| Rule | Description |
|------|-------------|
| BR-CUS-040 | GSTIN 15 characters in Indian format |
| BR-CUS-041 | PAN 10 characters in Indian format |
| BR-CUS-042 | GSTIN characters 3–12 must match PAN if both entered |
| BR-CUS-043 | Entering GSTIN auto-fills PAN if PAN is empty |
| BR-CUS-044 | GSTIN state code mismatch is a warning, not an error |

### Lifecycle

| Rule | Description |
|------|-------------|
| BR-CUS-050 | All new customers created Active |
| BR-CUS-051 | Active toggle disabled during creation |
| BR-CUS-052 | Deactivation blocked if customer has outstanding balance |
| BR-CUS-053 | Deactivation blocked if customer has open transactions |
| BR-CUS-054 | Cannot delete customer with any transaction history |
| BR-CUS-055 | Cannot delete customer with outstanding balance > 0 |
| BR-CUS-056 | Deleted customer ID permanently retired |
| BR-CUS-057 | Soft delete: deleted_at timestamp, data retained 7 years |

### Form

| Rule | Description |
|------|-------------|
| BR-CUS-060 | Unsaved changes guard on create and edit screens |
| BR-CUS-061 | Changes affect future transactions only |
| BR-CUS-062 | State change clears district and city |

---

## 24. Validation matrix

| Field | Rule | Error message |
|-------|------|---------------|
| Name | Required | "Customer name is required" |
| Name | < 3 chars | "Name must be at least 3 characters" |
| Name | > 100 chars | "Name cannot exceed 100 characters" |
| Name | Duplicate | "A customer with this name already exists" |
| Email | Invalid format | "Enter a valid email address" |
| Email | Duplicate | "This email is already used by another customer" |
| Phone | Not 10-digit Indian | "Enter a valid Indian phone number" |
| GSTIN | Invalid 15-char format | "Enter a valid 15-character GSTIN" |
| GSTIN | PAN mismatch | "PAN does not match the GSTIN entered" |
| GSTIN | State code mismatch | "GSTIN state code does not match selected state" (warning) |
| PAN | Invalid 10-char format | "Enter a valid 10-character PAN" |
| PIN Code | Not 6 digits | "PIN code must be 6 digits" |
| Credit limit | Negative | "Credit limit cannot be negative" |
| Payment days | Empty when Net custom | "Number of days is required" |
| Payment days | < 1 or > 999 | "Enter a value between 1 and 999" |
| Logo | Wrong format | "Only JPG and PNG images are supported" |
| Logo | > 1 MB | "Logo must be smaller than 1 MB" |
| Attachment | Wrong format | "Only PDF, JPG, PNG, DOC files are supported" |
| Attachment | > 1 MB | "File must be smaller than 1 MB" |
| Attachment | > 10 files | "Maximum 10 attachments per customer" |
| Contact name | Empty | "Contact name is required" |
| Deactivate | Has balance | "Cannot deactivate. [Name] has an outstanding balance of ₹X." |
| Deactivate | Open transactions | "Cannot deactivate. [Name] has open transactions." |
| Delete | Has transactions | "Cannot delete. This customer has purchase history." |
| Delete | Has balance | "Cannot delete. This customer has an outstanding balance of ₹X." |

---

## 25. Real-world scenarios

### Scenario 1 — Owner creates a regular B2B customer (restaurant)

```
Owner opens More → Customers → taps "+"
Name: "Spice Garden Restaurant"
Type: Regular
Phone: 9876543210
Email: accounts@spicegarden.com
GSTIN: 33AAPFU0939F1Z5 → PAN auto-fills: AAPFU0939F
State: Tamil Nadu
City: Chennai
PIN: 600001
Credit limit: ₹15,000
Payment terms: Net 30
Contact: Suresh, Purchase Manager, 9876543211
Notes: "Delivery only on weekdays before 12 PM"
Saves → CUS-001 created
```

---

### Scenario 2 — Cashier at POS selects a credit customer

```
Cashier scans items: ₹2,200 total
Taps customer picker
Selects: Sharma Ji
App shows:
  Credit limit: ₹5,000
  Outstanding: ₹3,500
  Available credit: ₹1,500

Adding ₹2,200 would exceed credit limit by ₹700
→ Warning shown to cashier
→ Cashier cannot proceed without manager override
→ Cashier calls the manager

Manager enters PIN
→ Override confirmed
→ Sale proceeds
→ Outstanding balance now ₹5,700 (exceeds limit, flagged)
```

---

### Scenario 3 — Typical day with Walk-in customers

```
40 transactions on Tuesday:
  Walk-in Customer: 32 transactions (₹8,400 total cash)
  Sharma Ji: 3 transactions (₹1,200 credit)
  XYZ Restaurant: 4 transactions (₹6,800 B2B)
  Priya: 1 transaction (₹340 cash)

Home screen shows:
  Today's sales: ₹16,740
  Walk-in: ₹8,400 (50.2%)
  Account: ₹8,340 (49.8%)
```

---

### Scenario 4 — Owner sends Diwali wishes using birthday data

```
Owner opens Home screen → "Upcoming birthdays" widget
  Sharma Ji — birthday Oct 29 (3 days away)
  Priya K   — birthday Nov 1 (6 days away)

Owner calls Sharma Ji, wishes Diwali + birthday,
offers 5% discount on next purchase
→ Customer retention without any CRM software
```

---

### Scenario 5 — Trying to delete a customer with balance

```
Owner tries to delete "XYZ Restaurant"
→ Check: 14 sales orders exist
→ Error: "Cannot delete. This customer has purchase history."

Owner decides to deactivate instead
→ Check: Outstanding balance ₹3,200
→ Error: "Cannot deactivate. XYZ Restaurant has an outstanding balance of ₹3,200.
          Collect payment before deactivating."

Owner calls XYZ Restaurant, collects ₹3,200
Records payment → balance = ₹0
Deactivates successfully
```

---

### Scenario 6 — Customer detail shows masked tax info for cashier

```
Role: Cashier
Opens customer: Spice Garden Restaurant
  Name: Spice Garden Restaurant  ✅ visible
  Phone: 9876543210              ✅ visible
  Credit limit: ₹15,000          ✅ visible (needed at POS)
  Outstanding: ₹4,200            ✅ visible (needed at POS)
  GSTIN: 33XXXXX939F1ZX          ❌ masked (8 chars hidden)
  PAN: hidden entirely
```

---

## 26. Dos and don'ts

**Store credit limit and outstanding balances in paise (integer).** Same rule as products. `credit_limit_paise = 1500000` (₹15,000) not `credit_limit = 15000.00`. Integer arithmetic is exact; floating-point is not.

**Format Indian currency with `en-IN` locale.** ₹1,00,000 not ₹100,000. The Indian numbering system uses lakh and crore separators. `(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 })` handles this correctly.

**The Walk-in Customer must always be available at POS.** Never filter it out of the POS customer picker. Never allow it to be deactivated. It is the fallback customer for every anonymous cash sale.

**Auto-extract PAN from GSTIN.** Characters 3–12 of any GSTIN are always the entity's PAN. Do this automatically to save data entry and reduce errors.

**Warn on GSTIN-state mismatch, never block.** Cross-state suppliers are common (Mumbai grocery importing from Gujarat). A mismatch between GSTIN state code and selected state is worth noting but not worth blocking the save.

**Credit limit check happens at checkout, not at product scan.** Checking the credit limit when each product is added creates annoying interruptions. Check once at checkout when the full cart total is known.

**Outstanding balance is only as fresh as the last sync.** A customer may have paid on another device but the payment hasn't synced yet. The credit limit check uses the local balance. This is an offline-first trade-off — document it clearly so support staff understand why a cashier might see a stale balance.

**Never let the cashier see raw GSTIN or PAN.** These are tax identifiers that can be used for fraud. Mask them in the UI for cashier role. Only owner and manager should see the full values.

**Deactivation for customers is stricter than for suppliers.** Suppliers can be deactivated regardless of history (deactivation is non-destructive and reversible). Customers cannot be deactivated if they have an outstanding balance — the money must be collected first. This is intentional — you don't want to "lose track" of a customer who owes money by hiding them from all screens.

**Never reuse customer IDs.** `customer_id` = `CUS-007` must always mean the same person, even after deletion. Historical sales orders printed with "CUS-007: Sharma Ji" must remain permanently traceable.

---

*Document version: 1.0 — Ayphen Retail Mobile — Customers*
*Adapted from: Customer Management PRD v1.0 (Ayphen Books) for Indian retail POS context*
*Includes: Walk-in Customer pattern for kirana cash sales, Indian tax fields (GSTIN/PAN), credit limit at POS enforcement, birthday/anniversary relationship fields*
