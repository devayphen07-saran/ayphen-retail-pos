# Suppliers — Ayphen Retail Mobile

Complete reference for the Suppliers module. Every field, every flow, every business rule, every real-world scenario for Indian retail.

---

## Table of contents

1. [What this module does](#1-what-this-module-does)
2. [Data model — complete schema](#2-data-model--complete-schema)
3. [Field specifications — General Information](#3-field-specifications--general-information)
4. [Field specifications — Contact and Communication](#4-field-specifications--contact-and-communication)
5. [Field specifications — Address](#5-field-specifications--address)
6. [Field specifications — Tax Registration](#6-field-specifications--tax-registration)
7. [Field specifications — Payment Configuration](#7-field-specifications--payment-configuration)
8. [Field specifications — Contact Persons](#8-field-specifications--contact-persons)
9. [Field specifications — Notes and Attachments](#9-field-specifications--notes-and-attachments)
10. [Form behaviour — how fields interact](#10-form-behaviour--how-fields-interact)
11. [Supplier create flow](#11-supplier-create-flow)
12. [Supplier edit flow](#12-supplier-edit-flow)
13. [Supplier delete flow](#13-supplier-delete-flow)
14. [Suppliers list screen](#14-suppliers-list-screen)
15. [Supplier detail screen](#15-supplier-detail-screen)
16. [Supplier status lifecycle](#16-supplier-status-lifecycle)
17. [RBAC — role-based access control](#17-rbac--role-based-access-control)
18. [Offline-first behaviour](#18-offline-first-behaviour)
19. [Sync behaviour](#19-sync-behaviour)
20. [Business rules — complete list](#20-business-rules--complete-list)
21. [Validation matrix](#21-validation-matrix)
22. [Real-world scenarios](#22-real-world-scenarios)
23. [Dos and don'ts](#23-dos-and-donts)

---

## 1. What this module does

The Suppliers module manages the vendors from whom a kirana or retail store procures goods. Every product linked to a supplier, every purchase bill, and every payment to a vendor depends on a clean, accurate supplier record.

**What it enables:**
- Owner creates supplier profiles once and reuses them across purchase flows
- Supplier GSTIN stored on the record so purchase bills are GST-compliant
- Payment terms (Net 30, Net 60, Cash) stored per supplier so the POS knows when each invoice is due
- Credit management — owner can see how much is owed to each supplier
- Contact details stored so the cashier can call the delivery person without searching

**What it does not do:**
- No general ledger account mapping (this is a POS, not accounting software)
- No multi-currency (INR only — all Indian retail)
- No supplier portal or connected-company cross-linking
- No ageing summary or statements (Phase 2)
- No price file / supplier-specific pricing (Phase 2)

---

## 2. Data model — complete schema

```sql
-- Core supplier table
suppliers (
  id                      INTEGER  PRIMARY KEY AUTOINCREMENT,
  guuid                   TEXT     NOT NULL UNIQUE,         -- UUID v4, global ID
  store_id                INTEGER  NOT NULL REFERENCES stores(id),

  -- Identity
  supplier_id             TEXT     NOT NULL,               -- auto-generated: SUP-001, SUP-002
  name                    TEXT     NOT NULL,               -- 3–100 chars, required
  display_name            TEXT,                            -- optional short name
  logo_uri                TEXT,                            -- local path or CDN URL

  -- Contact
  phone                   TEXT,                            -- 10-digit Indian mobile
  email                   TEXT,                            -- unique per store
  website                 TEXT,

  -- Tax (Indian)
  gstin                   TEXT,                            -- 15-char GST Identification Number
  pan_number              TEXT,                            -- 10-char PAN

  -- Payment
  payment_term_lookup_fk  INTEGER  REFERENCES lookups(id), -- Net30 / Net60 / Cash / EOM
  payment_term_days       INTEGER,                         -- for Net terms
  credit_limit_paise      INTEGER  DEFAULT 0,              -- 0 = no limit
  override_credit_limit   INTEGER  NOT NULL DEFAULT 0,     -- 1 = allow override

  -- Address (denormalised primary address)
  address_line_1          TEXT,
  address_line_2          TEXT,
  city                    TEXT,
  district                TEXT,
  state                   TEXT,                            -- Indian state
  pin_code                TEXT,                            -- 6-digit Indian PIN

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

-- Supplier contact persons (many per supplier)
supplier_contacts (
  id                      INTEGER  PRIMARY KEY AUTOINCREMENT,
  guuid                   TEXT     NOT NULL UNIQUE,
  supplier_guuid          TEXT     NOT NULL REFERENCES suppliers(guuid),
  store_id                INTEGER  NOT NULL,
  name                    TEXT     NOT NULL,               -- 3–100 chars
  designation             TEXT,                            -- job title
  phone                   TEXT,
  email                   TEXT,
  is_primary              INTEGER  NOT NULL DEFAULT 0,     -- one primary per supplier
  created_at              TEXT     NOT NULL,
  sync_status             TEXT     NOT NULL DEFAULT 'pending'
)

-- Supplier attachments
supplier_attachments (
  id                      INTEGER  PRIMARY KEY AUTOINCREMENT,
  guuid                   TEXT     NOT NULL UNIQUE,
  supplier_guuid          TEXT     NOT NULL REFERENCES suppliers(guuid),
  store_id                INTEGER  NOT NULL,
  file_name               TEXT     NOT NULL,
  file_uri                TEXT     NOT NULL,               -- local path
  file_type               TEXT     NOT NULL,               -- 'pdf'|'image'|'doc'
  file_size_bytes         INTEGER  NOT NULL,
  created_at              TEXT     NOT NULL,
  sync_status             TEXT     NOT NULL DEFAULT 'pending'
)
```

---

## 3. Field specifications — General Information

### 3.1 Supplier Name

| Attribute | Value |
|-----------|-------|
| Type | Text input |
| Mandatory | Yes |
| Min length | 3 characters |
| Max length | 100 characters |
| Uniqueness | Per store (case-insensitive) |
| Stored as | `name TEXT` |

**Critical behaviour — the form gate:** Until a valid name (3+ characters) is entered, **all other fields on the form are disabled**. This prevents half-complete supplier records and is the same pattern used in the Products form.

**Validation:**
```
Required             → "Supplier name is required"
< 3 chars            → "Name must be at least 3 characters"
> 100 chars          → "Name cannot exceed 100 characters"
Whitespace only      → "Name cannot be blank"
```

---

### 3.2 Supplier ID

| Attribute | Value |
|-----------|-------|
| Type | Auto-generated display field |
| Format | Prefix + sequential number (SUP-001, SUP-002) |
| Prefix | Configurable from store settings (default: "SUP") |
| Uniqueness | Per store, permanent |
| Editable | Never — always read-only |
| Stored as | `supplier_id TEXT` |

**Generation logic:**
1. Read prefix from store settings (default "SUP")
2. Find highest existing number for that prefix
3. Increment by 1
4. Generate: SUP-001, SUP-002, SUP-003 …

**Never reused:** Even if a supplier is deleted, their ID is permanently retired. This maintains audit trail integrity — a historical purchase bill referencing SUP-012 must always resolve to the same supplier.

---

### 3.3 Display Name

| Attribute | Value |
|-----------|-------|
| Type | Text input |
| Mandatory | No |
| Max length | 50 characters |
| Stored as | `display_name TEXT` |

Short name shown in compact UI contexts (list rows, POS scanner toast). Example: supplier name is "Hindustan Unilever Limited" but display name is "HUL". Falls back to full name if empty.

---

### 3.4 Supplier Logo

| Attribute | Value |
|-----------|-------|
| Type | Image picker |
| Mandatory | No |
| Formats | JPG, JPEG, PNG |
| Max size | 1 MB |
| Stored as | `logo_uri TEXT` |

**Phase 1:** Tap to select from camera roll or capture. Basic preview. Replace requires deleting existing logo first.

**Validation:**
```
Wrong format → "Only JPG and PNG images are supported"
> 1 MB       → "Logo must be smaller than 1 MB"
```

---

### 3.5 Active Toggle

| Attribute | Value |
|-----------|-------|
| Type | Toggle |
| Default | ON (cannot disable during creation) |
| Editable | Only in edit mode |
| Stored as | `is_active INTEGER` |

During creation: always ON and disabled. In edit mode: becomes interactive. Deactivating hides the supplier from purchase flows but preserves all data.

---

## 4. Field specifications — Contact and Communication

### 4.1 Phone Number

| Attribute | Value |
|-----------|-------|
| Type | Numeric text input |
| Mandatory | No |
| Format | 10-digit Indian mobile number |
| Calling code | +91 (fixed — Indian retail only) |
| Stored as | `phone TEXT` |

**Indian context:** Mobile numbers in India are exactly 10 digits starting with 6, 7, 8, or 9. Landline numbers have STD code + number. Accept both formats.

**Validation:**
```
Not 10 digits (mobile) or invalid format → "Enter a valid Indian phone number"
```

---

### 4.2 Email

| Attribute | Value |
|-----------|-------|
| Type | Email input |
| Mandatory | No |
| Max length | 255 characters |
| Uniqueness | Per store (case-insensitive) |
| Stored as | `email TEXT` |

**Validation:**
```
Invalid format         → "Enter a valid email address"
Duplicate in store     → "This email is already used by another supplier"
```

---

### 4.3 Website

| Attribute | Value |
|-----------|-------|
| Type | Text input (URL) |
| Mandatory | No |
| Stored as | `website TEXT` |

**Validation:**
```
Invalid URL → "Enter a valid website URL"
```

---

## 5. Field specifications — Address

**Indian address hierarchy:** Store → State → District → City → PIN Code (not Ireland's Region → County → Eircode).

### 5.1 Address Line 1

| Attribute | Value |
|-----------|-------|
| Type | Text input |
| Mandatory | No |
| Min length | 3 characters |
| Max length | 100 characters |

---

### 5.2 Address Line 2

| Attribute | Value |
|-----------|-------|
| Type | Text input |
| Mandatory | No |
| Max length | 100 characters |

---

### 5.3 City / Town

| Attribute | Value |
|-----------|-------|
| Type | Text input |
| Mandatory | No |
| Min length | 2 characters |
| Max length | 50 characters |

---

### 5.4 District

| Attribute | Value |
|-----------|-------|
| Type | Dropdown or text input |
| Mandatory | No |
| Source | `lookups` table, type = DISTRICT or text entry |
| Dependent on | State selection |
| Stored as | `district TEXT` |

---

### 5.5 State

| Attribute | Value |
|-----------|-------|
| Type | Dropdown |
| Mandatory | No |
| Source | Indian states and union territories (28 states + 8 UTs) |
| Stored as | `state TEXT` |

**Indian states list hardcoded:** Andhra Pradesh, Arunachal Pradesh, Assam, Bihar, Chhattisgarh, Goa, Gujarat, Haryana, Himachal Pradesh, Jharkhand, Karnataka, Kerala, Madhya Pradesh, Maharashtra, Manipur, Meghalaya, Mizoram, Nagaland, Odisha, Punjab, Rajasthan, Sikkim, Tamil Nadu, Telangana, Tripura, Uttar Pradesh, Uttarakhand, West Bengal + all 8 Union Territories.

**Cascade clear:** Changing state clears district and city.

---

### 5.6 PIN Code

| Attribute | Value |
|-----------|-------|
| Type | Numeric text |
| Mandatory | No |
| Format | Exactly 6 digits (Indian Postal Index Number) |
| Stored as | `pin_code TEXT` |

**Validation:**
```
Not 6 digits → "PIN code must be 6 digits"
Non-numeric  → "PIN code must contain only digits"
```

---

## 6. Field specifications — Tax Registration

**Indian context:** GSTIN is the primary tax identifier for B2B purchases. PAN is the income tax identifier. Both are relevant for purchase documentation and TDS.

### 6.1 GSTIN (GST Identification Number)

| Attribute | Value |
|-----------|-------|
| Type | Text input |
| Mandatory | No |
| Format | 15 characters: 2-digit state code + 10-char PAN + 1 entity number + 1 check digit + Z |
| Example | `27AAPFU0939F1Z5` (Maharashtra, Amul) |
| Uniqueness | Globally unique (one GSTIN per business nationally) |
| Stored as | `gstin TEXT` |

**Format validation:**
```
Regex: ^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$
Error: "Enter a valid 15-character GSTIN"
```

**First 2 digits = state code:** 27 = Maharashtra, 33 = Tamil Nadu, 29 = Karnataka etc. The state code must match the supplier's selected state. Warn (do not block) if they mismatch.

---

### 6.2 PAN (Permanent Account Number)

| Attribute | Value |
|-----------|-------|
| Type | Text input |
| Mandatory | No |
| Format | 10 characters: 5 letters + 4 digits + 1 letter |
| Example | `AAPFU0939F` |
| Uniqueness | Per store (same PAN can appear on multiple supplier records if same entity) |
| Stored as | `pan_number TEXT` |

**PAN is embedded in GSTIN:** Characters 3–12 of a GSTIN are the entity's PAN. If both are entered, validate that GSTIN positions 3–12 match the PAN.

**Validation:**
```
Format wrong → "Enter a valid 10-character PAN"
GSTIN-PAN mismatch → "PAN does not match the GSTIN entered"
```

---

## 7. Field specifications — Payment Configuration

### 7.1 Payment Terms

| Attribute | Value |
|-----------|-------|
| Type | Dropdown |
| Mandatory | No |
| Source | `lookups` table, type = PAYMENT_TERM |
| Default | From store settings |
| Stored as | `payment_term_lookup_fk INTEGER` |

**Standard Indian retail payment terms:**

| Term | Meaning | Days field |
|------|---------|-----------|
| Cash | Pay immediately on delivery | No |
| Net 7 | Pay within 7 days | No (fixed) |
| Net 15 | Pay within 15 days | No (fixed) |
| Net 30 | Pay within 30 days | No (fixed) |
| Net 60 | Pay within 60 days | No (fixed) |
| Net (custom) | Pay within N days | Yes — 1 to 999 |
| End of Month | Pay by end of current month | No |
| Due on Receipt | Pay immediately | No |

**Cash billing type → Due on Receipt auto-set:** When billing type = Cash, payment terms are forced to "Due on Receipt" and the field is disabled. Same behaviour as the supplier PRD.

---

### 7.2 Payment Term Days

| Attribute | Value |
|-----------|-------|
| Type | Integer input |
| Mandatory | Yes when Payment Term = "Net (custom)" |
| Range | 1–999 |
| Stored as | `payment_term_days INTEGER` |

**Validation:**
```
Net (custom) selected + Days empty → "Number of days is required"
Days < 1 or > 999                 → "Enter a value between 1 and 999"
Days is decimal                   → "Days must be a whole number"
```

---

### 7.3 Credit Limit

| Attribute | Value |
|-----------|-------|
| Type | Numeric (stored as paise) |
| Mandatory | No |
| Default | 0 (no limit) |
| Stored as | `credit_limit_paise INTEGER` |

The amount the store is allowed to owe this supplier before being blocked from new purchases. 0 means no limit enforced.

**Indian formatting:** Display as ₹X,XX,XXX (en-IN locale, no decimals for whole rupee amounts).

---

## 8. Field specifications — Contact Persons

Each supplier can have multiple contact persons. At most one is marked as primary.

### 8.1 Contact Name

| Attribute | Value |
|-----------|-------|
| Type | Text input |
| Mandatory | Yes per contact row |
| Min length | 3 characters |
| Max length | 100 characters |

---

### 8.2 Designation

| Attribute | Value |
|-----------|-------|
| Type | Text input |
| Mandatory | No |
| Max length | 50 characters |

Example: "Sales Manager", "Delivery Coordinator", "Accounts".

---

### 8.3 Phone (Contact Person)

| Attribute | Value |
|-----------|-------|
| Type | Numeric |
| Mandatory | No |
| Format | 10-digit Indian mobile |

---

### 8.4 Email (Contact Person)

| Attribute | Value |
|-----------|-------|
| Type | Email |
| Mandatory | No |
| Max length | 255 characters |

Contact person emails are **not** checked for uniqueness — the same person can be listed under multiple suppliers.

---

### 8.5 Primary Contact Toggle

| Attribute | Value |
|-----------|-------|
| Type | Toggle per row |
| Default | ON for first contact added |
| Rule | Only one primary contact per supplier |

When a new contact is marked primary, the previous primary auto-clears.

---

## 9. Field specifications — Notes and Attachments

### 9.1 Notes

| Attribute | Value |
|-----------|-------|
| Type | Text area |
| Mandatory | No |
| Max length | 250 characters |
| Stored as | `notes TEXT` |

Internal notes: supplier quality rating, delivery reliability, special instructions, seasonal availability.

---

### 9.2 Attachments

| Attribute | Value |
|-----------|-------|
| Type | File picker (multiple) |
| Mandatory | No |
| Max files | 10 per supplier |
| Max size | 1 MB per file |
| Formats | PDF, JPG, JPEG, PNG, DOC, DOCX |

Examples: supplier agreement, rate card, FSSAI licence copy, GST registration certificate.

**Validation:**
```
Wrong format → "Only PDF, JPG, PNG, DOC files are supported"
> 1 MB       → "File must be smaller than 1 MB"
> 10 files   → "Maximum 10 attachments per supplier"
```

---

## 10. Form behaviour — how fields interact

### 10.1 The form gate

```
name.length < 3 → ALL other fields are disabled
name.length >= 3 → All fields enable per their own rules
```

If the owner clears the name after filling other fields, all fields disable again. Values are **retained** — re-entering a valid name re-enables the form with previous values intact.

---

### 10.2 Payment terms drive Days field

```
Payment Term = "Net (custom)"
  → Days field appears and becomes mandatory

Payment Term = anything else
  → Days field hidden, value cleared
```

---

### 10.3 State drives district options

```
State selected
  → District dropdown populates with districts of that state
  → City field remains free text

State cleared
  → District clears
  → City clears
```

---

### 10.4 GSTIN state code warns on mismatch

```
GSTIN entered (e.g., 27AAPFU0939F1Z5 → state code 27 = Maharashtra)
State selected (e.g., Tamil Nadu)
  → Warning toast: "GSTIN state code (27=Maharashtra) does not match selected state"
  → Does NOT block save — warn only
```

---

### 10.5 GSTIN extracts PAN

```
Owner enters GSTIN: 27AAPFU0939F1Z5
PAN field is empty
  → Auto-fill PAN: AAPFU0939F (characters 3–12)
  → Toast: "PAN auto-filled from GSTIN"

If PAN already entered and conflicts with GSTIN
  → Error: "PAN does not match the GSTIN entered"
```

---

### 10.6 Toggle OFF → ON resets to store defaults

```
Payment Term toggled / cleared and re-selected
  → Store default payment term re-applied
  → Any previous manual selection is lost
  → This is intentional — treats clearing as a reset
```

---

## 11. Supplier create flow

```
Owner opens More → Suppliers → taps "+"
    ↓
SupplierCreateScreen opens as modal (no tab bar)
app/(store)/(main)/(tabs)/more/suppliers/create.tsx
→ features/suppliers/screens/SupplierCreateScreen.tsx
    ↓
Step 1: Enter supplier name (3+ characters)
        Form fields all disabled until name is valid
    ↓
Step 2: Configure fields
        (Contact, Address, Tax, Payment, Contacts, Notes)
    ↓
Step 3: Tap "Save"
    ↓
Validation runs:
  - Required fields
  - GSTIN format (if entered)
  - PAN format and GSTIN-PAN match (if both entered)
  - Email uniqueness (checked against local SQLite)
  - Phone format
  - PIN code 6 digits
    ↓
If validation fails → inline errors shown, save blocked
    ↓
If validation passes:
  - Supplier written to local SQLite (sync_status = 'pending')
  - supplier_id generated (SUP-001, etc.)
  - router.dismiss() → modal closes
  - Suppliers list refreshes
  - Success toast: "Supplier created"
    ↓
Sync engine picks up pending record and pushes to server
```

---

### 11.1 Unsaved changes guard

If the form is dirty and owner attempts to dismiss:

```
Alert: "Discard changes?"
  Cancel  → stay on form
  Discard → dismiss modal, changes lost
```

iOS: `gestureEnabled: false` on modal prevents accidental swipe-to-dismiss.

---

## 12. Supplier edit flow

```
Owner taps Edit on a supplier (from detail screen or swipe action)
    ↓
SupplierEditScreen opens as modal
    ↓
Form pre-filled with current values
    ↓
Locked fields (read-only, visually greyed):
  - Supplier ID (always read-only)
    ↓
Changes applied → updates to local SQLite (sync_status = 'pending')
router.dismiss()
Success toast: "Supplier updated"
```

**Note from PRD:** Changes to supplier details affect **future** transactions only. Existing purchase bills retain the supplier details as they were at the time of the transaction.

---

## 13. Supplier delete flow

### 13.1 Delete checks (in order)

```
Check 1: Does the supplier have any transactions?
  → Any purchase bill, order, or payment linked
  → Error: "Cannot delete. This supplier has been used in transactions."

Check 2: Is there outstanding credit (amount owed > 0)?
  → credit_limit_paise and current balance checks
  → Error: "Cannot delete. There is an outstanding balance with this supplier."

If all checks pass:
  → Confirmation: "Delete [Supplier Name]? This cannot be undone."
  → User confirms
  → Soft delete: suppliers.deleted_at = NOW()
  → Supplier ID permanently retired (never reused)
  → Sync engine sends delete to server
```

---

### 13.2 Deactivate vs Delete

| Action | Transactions | Reversible | Supplier list | Purchase flows |
|--------|-------------|------------|---------------|----------------|
| Deactivate | Preserved | Yes (re-activate) | Still visible (inactive filter) | Removed from dropdowns |
| Delete | Blocks if any exist | No | Removed | Removed |

**Recommendation:** Deactivate suppliers you no longer work with. Delete only suppliers created by mistake with no purchase history.

---

## 14. Suppliers list screen

### 14.1 Screen structure

```
Route:   app/(store)/(main)/(tabs)/more/suppliers/index.tsx
Feature: features/suppliers/screens/SupplierListScreen.tsx
Stack:   Inside more/ Stack — tab bar HIDDEN
```

### 14.2 Header

- Title: "Suppliers"
- Right: "+" add button (requires Supplier.create permission)

### 14.3 Search bar

Searches: supplier name, GSTIN, phone, supplier ID. Debounced 200ms, minimum 2 characters.

### 14.4 Status filter chips

```
All        — active + inactive suppliers
Active     — only is_active = 1
Inactive   — only is_active = 0
```

### 14.5 Supplier list row

Each row shows:
- Avatar (first 2 letters of name, distinct deterministic colour)
- Supplier name + Supplier ID below
- Phone number or email (whichever is set)
- Payment terms badge (Net 30, Cash, etc.)
- Outstanding balance in ₹ (if any)
- Chevron → navigates to supplier detail

### 14.6 Swipe actions

```
Swipe left reveals:
  [Edit — primary colour] → opens SupplierEditScreen modal
  [Delete — red]          → triggers delete flow with checks
```

Swipe disabled for cashier role (no edit/delete permission).

---

## 15. Supplier detail screen

```
Route:   app/(store)/(main)/(tabs)/more/suppliers/[guuid]/index.tsx
Feature: features/suppliers/screens/SupplierDetailScreen.tsx
Stack:   Inside more/ Stack — tab bar HIDDEN
```

**Sections displayed:**
- Header: logo/avatar, name, supplier ID, active/inactive badge
- Contact: phone, email, website
- Tax: GSTIN, PAN
- Payment: terms, credit limit
- Address: full formatted Indian address
- Contact persons: list with primary contact highlighted
- Notes and attachments
- Purchase history (Phase 2 — placeholder for now)

**Header right actions:**
- Edit (requires Supplier.edit permission)
- Delete kebab option (requires Supplier.delete permission)
- Deactivate / Activate toggle (requires Supplier.edit permission)

---

## 16. Supplier status lifecycle

```
NEW → (valid save) → ACTIVE
ACTIVE → (deactivate, no transactions required) → INACTIVE
INACTIVE → (activate) → ACTIVE
ACTIVE or INACTIVE → (delete, no transactions) → DELETED (terminal)
```

### 16.1 Status rules

| Status | Purchase flows | Editable | Deletable |
|--------|---------------|----------|-----------|
| ACTIVE | Available in all dropdowns | Yes | Yes (if no transactions) |
| INACTIVE | Hidden from all dropdowns | Yes | Yes (if no transactions) |
| DELETED | Removed from system | No | N/A — terminal |

### 16.2 Deactivation

**Can deactivate even if supplier has transactions.** Unlike deletion, deactivation is reversible and non-destructive. The PRD for the Books app blocks deactivation if transactions exist — in the retail mobile app, deactivation is always allowed. The owner should be able to mark a supplier as inactive when they stop working with them, regardless of historical purchase history.

### 16.3 Activation

No conditions. Any inactive supplier can be reactivated at any time. No confirmation required — the action is safe and reversible.

---

## 17. RBAC — role-based access control

### 17.1 Permission matrix

| Action | Owner | Manager | Cashier |
|--------|-------|---------|---------|
| View supplier list | ✅ | ✅ | ✅ |
| View supplier detail | ✅ | ✅ | ✅ |
| Create supplier | ✅ | ✅ | ❌ |
| Edit supplier | ✅ | ✅ | ❌ |
| Deactivate supplier | ✅ | ✅ | ❌ |
| Delete supplier | ✅ | ❌ | ❌ |
| View GSTIN / PAN | ✅ | ✅ | ❌ |
| View credit limit | ✅ | ✅ | ❌ |

### 17.2 Enforcement layers

**Layer 1 — More screen navigation**

Suppliers item in the More grid is always visible (all roles can see supplier list for reference).

**Layer 2 — Layout RBAC guard**

```typescript
// more/suppliers/_layout.tsx
// No guard — all roles can view
// Guards applied at screen level for create/edit/delete actions
```

**Layer 3 — Screen-level UI**

- No "+" button shown if no create permission
- No Edit button on detail screen if no edit permission
- Swipe actions hidden if no edit/delete permission
- GSTIN and PAN masked for cashier role: "27XXXXX939F1Z5"

---

## 18. Offline-first behaviour

| Operation | Offline behaviour |
|-----------|-----------------|
| View supplier list | ✅ Reads from local SQLite |
| Search suppliers | ✅ Reads from local SQLite |
| Create supplier | ✅ Saved locally, queued for sync |
| Edit supplier | ✅ Saved locally, queued for sync |
| Deactivate supplier | ✅ Updated locally, queued for sync |
| Delete supplier | ✅ Soft-deleted locally, queued for sync |
| GSTIN format validation | ✅ Regex runs offline |
| Email uniqueness check | ✅ Checked against local SQLite |

**Conflict on email uniqueness:** If two devices create a supplier with the same email while offline, the second sync will be rejected by the server. The second device will see the supplier in `sync_status = 'conflict'` and the owner must change the email or merge the records via the Sync Issues screen.

---

## 19. Sync behaviour

### 19.1 Sync payload

```typescript
toSyncShape(supplier: SupplierRow): SupplierSyncPayload {
  return {
    guuid:                  supplier.guuid,
    supplier_id:            supplier.supplier_id,
    name:                   supplier.name,
    display_name:           supplier.display_name,
    phone:                  supplier.phone,
    email:                  supplier.email,
    gstin:                  supplier.gstin,
    pan_number:             supplier.pan_number,
    payment_term_lookup_fk: supplier.payment_term_lookup_fk,
    payment_term_days:      supplier.payment_term_days,
    credit_limit_paise:     supplier.credit_limit_paise,
    address_line_1:         supplier.address_line_1,
    address_line_2:         supplier.address_line_2,
    city:                   supplier.city,
    district:               supplier.district,
    state:                  supplier.state,
    pin_code:               supplier.pin_code,
    is_active:              supplier.is_active,
    notes:                  supplier.notes,
    deleted_at:             supplier.deleted_at,
  };
}
```

### 19.2 Entity applier

`src/infrastructure/sync/entity-appliers/supplier.ts` handles incoming server changes. Applies using `INSERT OR REPLACE` on `guuid`. If a server record has `deleted_at` set, the local record is also soft-deleted.

---

## 20. Business rules — complete list

### Identity

| Rule | Description |
|------|-------------|
| BR-SUP-001 | Supplier name is mandatory, 3–100 characters |
| BR-SUP-002 | All form fields disabled until name has 3+ valid characters |
| BR-SUP-003 | Supplier name is unique per store (case-insensitive) |
| BR-SUP-004 | Supplier ID is auto-generated and never manually editable |
| BR-SUP-005 | Supplier ID is permanent — never reused after deletion |
| BR-SUP-006 | Email is unique per store (case-insensitive) |

### Tax (Indian)

| Rule | Description |
|------|-------------|
| BR-SUP-010 | GSTIN must be 15 characters in format: 2-digit state + PAN + entity + check + Z |
| BR-SUP-011 | PAN must be 10 characters: 5 letters + 4 digits + 1 letter |
| BR-SUP-012 | GSTIN characters 3–12 must match PAN if both are entered |
| BR-SUP-013 | GSTIN state code mismatch with selected state triggers warning (not error) |
| BR-SUP-014 | Entering GSTIN auto-populates PAN if PAN field is empty |

### Payment

| Rule | Description |
|------|-------------|
| BR-SUP-020 | Payment term days (1–999) is required when Payment Term = "Net (custom)" |
| BR-SUP-021 | Credit limit 0 means no limit enforced |
| BR-SUP-022 | Credit limit stored in paise (integer) |

### Address

| Rule | Description |
|------|-------------|
| BR-SUP-030 | PIN code must be exactly 6 digits |
| BR-SUP-031 | Changing state clears district and city |

### Contact persons

| Rule | Description |
|------|-------------|
| BR-SUP-040 | Contact name is required per contact row (3–100 chars) |
| BR-SUP-041 | At most one primary contact per supplier |
| BR-SUP-042 | Marking a contact as primary auto-clears the previous primary |
| BR-SUP-043 | Contact person emails not checked for uniqueness |

### Lifecycle

| Rule | Description |
|------|-------------|
| BR-SUP-050 | All new suppliers created as Active |
| BR-SUP-051 | Active toggle disabled during creation — cannot create inactive supplier |
| BR-SUP-052 | Deactivation is always allowed regardless of transaction history |
| BR-SUP-053 | Cannot delete supplier with any transaction history |
| BR-SUP-054 | Deleted supplier's ID permanently retired (never reused) |
| BR-SUP-055 | Soft delete: `deleted_at` timestamp set, data retained 7 years (GST audit) |

### Form behaviour

| Rule | Description |
|------|-------------|
| BR-SUP-060 | Unsaved changes guard on both create and edit screens |
| BR-SUP-061 | Clearing payment terms re-applies store defaults on re-selection |
| BR-SUP-062 | Changes to supplier details affect future transactions only |

---

## 21. Validation matrix

| Field | Rule | Error message |
|-------|------|---------------|
| Name | Required | "Supplier name is required" |
| Name | < 3 chars | "Name must be at least 3 characters" |
| Name | > 100 chars | "Name cannot exceed 100 characters" |
| Name | Duplicate in store | "A supplier with this name already exists" |
| Email | Invalid format | "Enter a valid email address" |
| Email | Duplicate in store | "This email is already used by another supplier" |
| Phone | Not 10-digit Indian format | "Enter a valid Indian phone number" |
| GSTIN | Invalid 15-char format | "Enter a valid 15-character GSTIN" |
| GSTIN | PAN mismatch | "PAN does not match the GSTIN entered" |
| GSTIN | State code mismatch | "GSTIN state code does not match selected state" (warning only) |
| PAN | Invalid 10-char format | "Enter a valid 10-character PAN" |
| PIN Code | Not 6 digits | "PIN code must be 6 digits" |
| Payment Days | Empty when Net custom | "Number of days is required" |
| Payment Days | < 1 or > 999 | "Enter a value between 1 and 999" |
| Logo | Wrong format | "Only JPG and PNG images are supported" |
| Logo | > 1 MB | "Logo must be smaller than 1 MB" |
| Attachment | Wrong format | "Only PDF, JPG, PNG, DOC files are supported" |
| Attachment | > 1 MB | "File must be smaller than 1 MB" |
| Attachment | > 10 files | "Maximum 10 attachments per supplier" |
| Contact name | Empty | "Contact name is required" |
| Contact name | < 3 chars | "Contact name must be at least 3 characters" |
| Delete | Has transactions | "Cannot delete. This supplier has been used in transactions." |

---

## 22. Real-world scenarios

### Scenario 1 — Owner adds Amul as a supplier

```
Owner opens More → Suppliers → taps "+"
Enters name: "Amul Dairy" → form enables
Phone: 9876543210
GSTIN: 24AAAAA0000A1Z5 (Gujarat)
State: Gujarat → PIN auto-fills GSTIN warning check (no mismatch)
PAN auto-fills: AAAAA0000A (from GSTIN)
Payment terms: Net 30
Credit limit: ₹50,000
Contact: Rajesh Patel, Sales Manager, 9876543211
Notes: "Deliver Tuesdays and Fridays only"
Saves → SUP-001 created
```

---

### Scenario 2 — Owner deactivates a supplier who stopped supplying

```
Supplier "Parle Distributors" (SUP-007) has stopped supplying
Owner goes to More → Suppliers → taps SUP-007 → Edit
Active toggle: OFF
Saves
→ Parle Distributors disappears from all purchase dropdowns
→ Historical purchase bills are untouched
→ Owner can re-activate whenever supply resumes
```

---

### Scenario 3 — Cashier tries to view a supplier's GSTIN

```
Role: Cashier (no tax information permission)
Opens supplier detail for "HUL"
GSTIN field shows: "27XXXXX939F1Z5" (masked)
PAN field: hidden
Cashier can see name, phone, contact person — but not tax details
```

---

### Scenario 4 — Owner tries to delete a supplier with purchase history

```
Owner swipes left on "Britannia Industries"
Delete button appears
Owner taps Delete
→ System checks: 14 purchase bills exist
→ Error toast: "Cannot delete. This supplier has been used in 14 transactions."
→ Owner can deactivate instead
```

---

### Scenario 5 — GSTIN auto-populates PAN

```
Owner is creating a new supplier
Enters GSTIN: 33AACFB1234D1ZC
→ System extracts characters 3–12: AACFB1234D
→ PAN field auto-fills: AACFB1234D
→ Toast: "PAN auto-filled from GSTIN"
Owner verifies and saves — one less field to type
```

---

## 23. Dos and don'ts

**Always store credit limit in paise (integer).** `credit_limit_paise = 5000000` (₹50,000) not `credit_limit = 50000.00`. Floating-point arithmetic on currency causes rounding errors.

**Always format Indian currency with `en-IN` locale.** `(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 })` produces "₹50,000" (Indian comma grouping) not "₹50,000" (same here but matters for lakhs: ₹1,00,000 not ₹100,000).

**Validate GSTIN with a regex, not just length.** A 15-character string is not automatically a valid GSTIN. The pattern `^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$` catches most invalid entries.

**Auto-extract PAN from GSTIN.** Characters 3–12 of a GSTIN are always the entity's PAN. Auto-filling saves the owner from entering the same information twice and reduces typos.

**Warn on GSTIN-state mismatch but do not block save.** The owner may have entered the correct state code GSTIN for a supplier registered in a different state (cross-state supplier). A hard block would be wrong — warn and let them confirm.

**Use deactivation, not deletion, for suppliers who stop supplying.** Deletion is blocked if any transactions exist. Deactivation is always allowed, is reversible, and correctly hides the supplier from dropdowns.

**Mask tax details (GSTIN, PAN) for cashier role.** These are sensitive business information. Cashiers do not need to see tax identifiers and leaking them creates privacy concerns.

**Never send `supplier_id` as a user-editable field to the backend.** The ID is generated locally and confirmed by the server. If the backend generates its own IDs, use `guuid` as the stable cross-device identifier and treat `supplier_id` as a display-only sequence number.

---

*Document version: 1.0 — Ayphen Retail Mobile — Suppliers*
*Adapted from: Supplier Management PRD v2.0 (Ayphen Books) for Indian retail POS context*
