# Stock Adjustment — Ayphen Retail Mobile

Complete reference for the Stock Adjustment module. Every field, every flow, every business rule, and every real-world scenario for Indian retail.

---

## Table of contents

1. [What this module does](#1-what-this-module-does)
2. [Adjustment types](#2-adjustment-types)
3. [Data model — complete schema](#3-data-model--complete-schema)
4. [FIFO costing — how unit cost is determined](#4-fifo-costing--how-unit-cost-is-determined)
5. [Field specifications — Header](#5-field-specifications--header)
6. [Field specifications — Line Items](#6-field-specifications--line-items)
7. [Calculation rules](#7-calculation-rules)
8. [Stock Adjustment create flow](#8-stock-adjustment-create-flow)
9. [Stock Adjustment edit flow](#9-stock-adjustment-edit-flow)
10. [Stock Adjustment delete flow](#10-stock-adjustment-delete-flow)
11. [Stock Adjustments list screen](#11-stock-adjustments-list-screen)
12. [Stock History view](#12-stock-history-view)
13. [System-Generated adjustments](#13-system-generated-adjustments)
14. [Stock Adjustment status lifecycle](#14-stock-adjustment-status-lifecycle)
15. [RBAC — role-based access control](#15-rbac--role-based-access-control)
16. [Offline-first behaviour](#16-offline-first-behaviour)
17. [Sync behaviour](#17-sync-behaviour)
18. [Business rules — complete list](#18-business-rules--complete-list)
19. [Validation matrix](#19-validation-matrix)
20. [Real-world scenarios](#20-real-world-scenarios)
21. [Dos and don'ts](#21-dos-and-donts)

---

## 1. What this module does

The Stock Adjustment module corrects the difference between physical stock and the system's stock records. When goods are damaged in the storeroom, when the owner suspects theft, or when products expire before they can be sold, a stock adjustment removes those units from the system so the numbers match reality.

**What it enables:**
- Owner writes off damaged, stolen, or expired stock with the correct reason code
- Unit cost is calculated using FIFO — oldest stock layers consumed first
- Every adjustment is logged with reason, quantity, and value so the owner has an audit trail
- Stock History shows every movement on every product chronologically — purchases in, sales out, adjustments
- System-Generated adjustments (created automatically by purchase bills, sales invoices, stock transfers) appear in the same history for a complete picture

**What it does not do in Phase 1:**
- No multi-level approval workflow (single owner — auto-approved)
- No GL journal entries (this is a POS, not accounting software)
- No locked accounting periods
- No stock value adjustments (quantity stays the same, value changes) — separate Phase 2 feature
- No backdated transaction recalculation cascade — Phase 2

---

## 2. Adjustment types

### 2.1 Manual adjustments (user-created)

Always **Stock Out** — they reduce inventory. The owner or manager creates these when physical goods are lost.

| Reason | Indian retail context |
|--------|----------------------|
| Damaged | Broken bottles, crushed packets, water damage in storage |
| Stolen | Shoplifting, employee pilferage |
| Expired | FMCG goods past expiry date (biscuits, dairy, medicines) |

### 2.2 System-Generated adjustments (auto-created)

Created automatically by the system when parent transactions are processed. These are **read-only** — they cannot be edited or deleted by any user regardless of permission level.

| Parent transaction | Direction | Reason code |
|-------------------|-----------|-------------|
| Purchase Bill | Stock In | Purchase |
| Sales Invoice | Stock Out | Sales |
| Sales Receipt | Stock Out | Sales |
| Customer Credit Note (return) | Stock In | Sales Return |
| Supplier Credit Note (return) | Stock Out | Purchase Return |
| Stock Transfer (source) | Stock Out | Stock Transfer |
| Stock Transfer (destination) | Stock In | Stock Transfer |
| Stock Take | Stock In or Out | Stock Take |

### 2.3 Key concepts

| Concept | Definition |
|---------|------------|
| Stock Out | Movement of goods out of inventory — decreases quantity and value |
| Stock In | Movement of goods into inventory — increases quantity and value |
| FIFO | First-In, First-Out — oldest cost layers consumed first for stock out |
| Opening Quantity | Stock on hand before this adjustment |
| Difference Quantity | Quantity being written off (manual) or moved (system) |
| Closing Quantity | Opening Quantity − Difference Quantity. Can be negative if store allows |
| Difference Value | Difference Quantity × Unit Cost (from FIFO layer) |

---

## 3. Data model — complete schema

```sql
-- Manual and System-Generated stock adjustments
stock_adjustments (
  id                    INTEGER  PRIMARY KEY AUTOINCREMENT,
  guuid                 TEXT     NOT NULL UNIQUE,
  store_id              INTEGER  NOT NULL REFERENCES stores(id),

  -- Identity
  adjustment_id         TEXT     NOT NULL,                  -- auto: SA-001, SA-002
  adjustment_type       TEXT     NOT NULL,                  -- 'manual' | 'system'
  parent_transaction_id TEXT,                               -- guuid of Bill/Invoice/etc (system only)
  parent_transaction_type TEXT,                             -- 'bill'|'invoice'|'stock_take'|etc

  -- Header
  location_id           INTEGER  NOT NULL REFERENCES locations(id),
  adjustment_date       TEXT     NOT NULL,                  -- ISO date
  reason_code           TEXT     NOT NULL,                  -- see Appendix A
  description           TEXT,                               -- 0–250 chars
  created_by_user_id    INTEGER  NOT NULL,

  -- Status
  status                TEXT     NOT NULL DEFAULT 'approved', -- 'approved'|'deleted'

  -- Notes
  notes                 TEXT,

  -- Sync
  created_at            TEXT     NOT NULL,
  updated_at            TEXT     NOT NULL,
  deleted_at            TEXT,
  sync_status           TEXT     NOT NULL DEFAULT 'pending'
)

-- Line items (one row per product per adjustment)
stock_adjustment_lines (
  id                    INTEGER  PRIMARY KEY AUTOINCREMENT,
  guuid                 TEXT     NOT NULL UNIQUE,
  adjustment_guuid      TEXT     NOT NULL REFERENCES stock_adjustments(guuid),
  store_id              INTEGER  NOT NULL,

  product_guuid         TEXT     NOT NULL REFERENCES products(guuid),
  storage_area          TEXT,                               -- storage area within location

  -- Quantities
  opening_quantity      REAL     NOT NULL DEFAULT 0,        -- stock before adjustment
  difference_quantity   REAL     NOT NULL,                  -- qty written off (must be > 0 for manual)
  closing_quantity      REAL     NOT NULL,                  -- opening - difference (can be negative)

  -- Values (paise)
  unit_cost_paise       INTEGER  NOT NULL DEFAULT 0,        -- from FIFO layer at time of adjustment
  difference_value_paise INTEGER NOT NULL DEFAULT 0,        -- difference_qty × unit_cost
  opening_value_paise   INTEGER  NOT NULL DEFAULT 0,
  closing_value_paise   INTEGER  NOT NULL DEFAULT 0,

  -- Sync
  created_at            TEXT     NOT NULL,
  sync_status           TEXT     NOT NULL DEFAULT 'pending'
)

-- Stock History — the complete movement ledger per product
-- This table is the source of truth for the Stock History view
stock_history (
  id                    INTEGER  PRIMARY KEY AUTOINCREMENT,
  guuid                 TEXT     NOT NULL UNIQUE,
  store_id              INTEGER  NOT NULL,
  product_guuid         TEXT     NOT NULL REFERENCES products(guuid),
  location_id           INTEGER  NOT NULL,
  storage_area          TEXT,

  -- Transaction reference
  transaction_type      TEXT     NOT NULL,                  -- 'purchase'|'sale'|'manual_adj'|'stock_take'|'transfer'|'return'
  transaction_guuid     TEXT     NOT NULL,                  -- reference to parent record
  transaction_ref       TEXT     NOT NULL,                  -- display: SA-001, B-012, INV-034
  transaction_date      TEXT     NOT NULL,

  -- Movement
  stock_in              REAL     NOT NULL DEFAULT 0,
  stock_out             REAL     NOT NULL DEFAULT 0,

  -- Balances
  opening_balance       REAL     NOT NULL DEFAULT 0,
  closing_balance       REAL     NOT NULL DEFAULT 0,

  -- Values (paise)
  opening_value_paise   INTEGER  NOT NULL DEFAULT 0,
  debit_value_paise     INTEGER  NOT NULL DEFAULT 0,        -- stock in × cost
  credit_value_paise    INTEGER  NOT NULL DEFAULT 0,        -- stock out × FIFO cost
  closing_value_paise   INTEGER  NOT NULL DEFAULT 0,

  -- FIFO layer source
  unit_cost_paise       INTEGER  NOT NULL DEFAULT 0,

  -- Sync
  created_at            TEXT     NOT NULL,
  sync_status           TEXT     NOT NULL DEFAULT 'pending'
)

-- FIFO cost layers — one row per purchase batch per product
fifo_cost_layers (
  id                    INTEGER  PRIMARY KEY AUTOINCREMENT,
  guuid                 TEXT     NOT NULL UNIQUE,
  store_id              INTEGER  NOT NULL,
  product_guuid         TEXT     NOT NULL REFERENCES products(guuid),
  location_id           INTEGER  NOT NULL,
  storage_area          TEXT,

  -- Layer details
  purchase_date         TEXT     NOT NULL,                  -- ISO datetime
  source_transaction_guuid TEXT  NOT NULL,                  -- Bill guuid
  original_quantity     REAL     NOT NULL,                  -- qty received in this batch
  remaining_quantity    REAL     NOT NULL,                  -- qty not yet consumed
  unit_cost_paise       INTEGER  NOT NULL,                  -- cost per unit in this batch

  -- Sync
  created_at            TEXT     NOT NULL,
  sync_status           TEXT     NOT NULL DEFAULT 'pending'
)
```

---

## 4. FIFO costing — how unit cost is determined

FIFO (First-In, First-Out) means that when stock is removed (sold, adjusted, transferred), the oldest purchase batch is consumed first.

### 4.1 How FIFO layers are built

Every purchase (Bill) creates a FIFO layer:

```
Date        Transaction   Qty    Unit Cost    Layer
2025-01-01  Bill B-001   100     ₹10/unit     Layer 1: 100 units @ ₹10
2025-01-15  Bill B-002    50     ₹12/unit     Layer 2:  50 units @ ₹12
2025-02-01  Bill B-003    80     ₹11/unit     Layer 3:  80 units @ ₹11

Total available: 230 units
```

### 4.2 How FIFO layers are consumed

When 120 units are sold or adjusted out:

```
Consume Layer 1: 100 units @ ₹10 = ₹1,000  (layer 1 fully exhausted)
Consume Layer 2:  20 units @ ₹12 = ₹240    (layer 2 partially consumed, 30 units remain)

Credit Value = ₹1,240
Unit Cost for this transaction = ₹1,240 ÷ 120 = ₹10.33 average across the consumed layers
```

### 4.3 FIFO rules by transaction type

| Transaction | Direction | Costing rule |
|------------|-----------|-------------|
| Purchase (Bill) | Stock In | Creates new FIFO layer at bill unit price |
| Sales (Invoice/Receipt) | Stock Out | Consumes oldest layers first (FIFO) |
| Manual Adjustment — Damaged/Stolen/Expired | Stock Out | Consumes oldest layers first (FIFO) |
| Stock Take adjustment (stock out) | Stock Out | Consumes oldest layers first (FIFO) |
| Stock Take adjustment (stock in) | Stock In | Uses product's default cost if no layers exist |
| Purchase Return | Stock Out | Removes from oldest layers (FIFO) |
| Sales Return (linked) | Stock In | Returns at original invoice cost (LIFO — last sold) |
| Sales Return (unlinked) | Stock In | Uses most recent purchase price |
| Stock Transfer out | Stock Out | Consumes oldest layers first (FIFO) |
| Stock Transfer in | Stock In | Carries forward cost from source (no revaluation) |

### 4.4 Unit cost when no FIFO layers exist

If a Stock Take or adjustment is created for a product that has never been purchased (no cost layers):

```
Unit Cost = product.case_cost_paise ÷ (case_quantity × pack_size)
           (the default cost from the product's case configuration)

If no cost configured either → Unit Cost = 0
```

---

## 5. Field specifications — Header

### 5.1 Adjustment ID

| Attribute | Value |
|-----------|-------|
| Type | Auto-generated |
| Format | SA-001, SA-002 (prefix configurable from store settings) |
| Uniqueness | Per store, permanent |
| Editable | Never |
| Stored as | `adjustment_id TEXT` |

Never reused after deletion — historical purchase bills referencing SA-042 must always be traceable.

---

### 5.2 Location

| Attribute | Value |
|-----------|-------|
| Type | Dropdown |
| Mandatory | Yes |
| Source | Active locations for this store |
| Stored as | `location_id INTEGER` |

**Form gate:** Selecting a location is the first step. All other fields and the Add Product button remain disabled until location is selected. Changing location after products are added clears all line items (with confirmation).

---

### 5.3 Date

| Attribute | Value |
|-----------|-------|
| Type | Date picker |
| Mandatory | Yes |
| Default | Today |
| Range | First purchase date for this store to today |
| Future dates | Not allowed |
| Stored as | `adjustment_date TEXT` |

Changing date after products are added clears all line items (with confirmation). Date affects which FIFO layers are available for valuation.

---

### 5.4 Reason

| Attribute | Value |
|-----------|-------|
| Type | Dropdown |
| Mandatory | Yes |
| Options | Damaged / Stolen / Expired |
| Stored as | `reason_code TEXT` |

**Why these three:**
- **Damaged** — physical damage (broken bottle, crushed carton, flood-damaged goods)
- **Stolen** — shoplifting or employee pilferage (requires the owner to acknowledge the loss type)
- **Expired** — goods past their expiry date, cannot be sold (FMCG, medicine, dairy)

---

### 5.5 Description

| Attribute | Value |
|-----------|-------|
| Type | Text area |
| Mandatory | No |
| Max length | 250 characters |
| Stored as | `description TEXT` |

Examples: "Flood damage in back storage 15 Jan", "3 cartons found expired during Diwali stock check", "Missing after stockroom camera reviewed".

---

## 6. Field specifications — Line Items

### 6.1 Product

| Attribute | Value |
|-----------|-------|
| Mandatory | Yes (at least one line item required) |
| Eligible | Goods with `track_inventory = 1` or `track_quantity = 1` |
| Ineligible | Services, non-trackable goods, inactive products |

---

### 6.2 Storage Area

| Attribute | Value |
|-----------|-------|
| Type | Dropdown |
| Mandatory | Yes per line item |
| Source | Storage areas configured for selected location |

Same product can appear in multiple line items if different storage areas. Same product + same storage area combination is blocked as duplicate.

---

### 6.3 Opening Quantity

| Attribute | Value |
|-----------|-------|
| Type | Read-only display |
| Source | System-calculated from stock history at the adjustment date |

Shows current stock on hand for this product at this storage area as of the adjustment date. This is what the system thinks is there before the adjustment.

---

### 6.4 Opening Value

| Attribute | Value |
|-----------|-------|
| Type | Read-only display |
| Source | Sum of FIFO layer values for available stock |
| Format | ₹X,XX,XXX (en-IN locale) |

---

### 6.5 Unit Cost

| Attribute | Value |
|-----------|-------|
| Type | Read-only display |
| Source | Derived from FIFO layers at the adjustment date |

The weighted average cost across the FIFO layers that will be consumed by this adjustment. Read-only — never user-editable.

---

### 6.6 Difference Quantity

| Attribute | Value |
|-----------|-------|
| Type | Numeric input |
| Mandatory | Yes |
| Min value | > 0 (cannot be zero or negative for manual adjustments) |
| Decimal support | For Measure to Sell products (up to 3 decimal places) |
| Stored as | `difference_quantity REAL` |

**Why > 0:** Manual adjustments are always Stock Out — they write off goods that no longer exist. Entering 0 means nothing was lost, which is not a valid adjustment.

---

### 6.7 Difference Value

| Attribute | Value |
|-----------|-------|
| Type | Read-only, auto-calculated |
| Formula | `difference_quantity × unit_cost_paise` |
| Format | ₹X,XX,XXX |

Calculated automatically when Difference Quantity is entered. Recalculates if quantity changes.

---

### 6.8 Closing Quantity

| Attribute | Value |
|-----------|-------|
| Type | Read-only, auto-calculated |
| Formula | `opening_quantity − difference_quantity` |
| Can be negative | Yes, if store settings allow negative inventory |

**Example:**
```
Opening: 5 units
Difference: 8 units (owner adjusting out 8 expired units)
Closing: 5 − 8 = −3 units (negative stock — indicates data error or previous under-recording)
```

---

### 6.9 Delete line item

Clicking the delete icon on a line item removes it immediately with no confirmation popup. The line item is gone — the owner must re-add it if needed.

---

## 7. Calculation rules

```
Difference Value   = Difference Quantity × Unit Cost (from FIFO)
Closing Quantity   = Opening Quantity − Difference Quantity
Closing Value      = Opening Value − Difference Value

Unit Cost derivation:
  1. Find all FIFO layers for this product + location + storage area
     that have remaining_quantity > 0, ordered by purchase_date ASC
  2. Consume layers oldest-first until difference_quantity is satisfied
  3. Unit Cost = total_cost_of_consumed_layers ÷ difference_quantity
```

**Recalculation triggers:**
Any of these changes trigger recalculation of Difference Value, Closing Quantity, and Closing Value:
- Difference Quantity changed
- Product changed (new FIFO layers)
- Storage Area changed (different FIFO pool)
- Date changed (different FIFO layer state at that date)

---

## 8. Stock Adjustment create flow

```
Owner opens Products tab → navigates to a product detail
or More → Stock → Stock Adjustments → taps "+"
    ↓
StockAdjustmentCreateScreen opens as modal (no tab bar)
app/(store)/stock-adjustment-create.tsx
→ features/stock-adjustments/screens/StockAdjustmentCreateScreen.tsx
    ↓
Step 1: Select Location (mandatory — unlocks all other fields)
Step 2: Select Date (default: today)
Step 3: Select Reason (Damaged / Stolen / Expired)
Step 4: Enter Description (optional)
    ↓
Step 5: Tap "Add Product"
  → Product selection popup
  → Search / filter eligible products
  → Select one or more → "Add to Adjustment"
  → Line items appear
    ↓
Step 6: Per line item:
  → Select Storage Area (mandatory)
  → System displays Opening Quantity, Opening Value, Unit Cost
  → Enter Difference Quantity (must be > 0)
  → System calculates Difference Value and Closing Quantity
    ↓
Step 7: Tap "Save"
    ↓
Validation:
  - Location selected
  - Date valid (not future, within range)
  - Reason selected
  - At least one line item
  - All line items have Storage Area
  - All Difference Quantities > 0
    ↓
If validation fails → inline errors shown, save blocked
    ↓
If validation passes:
  - Adjustment written to local SQLite (sync_status = 'pending')
  - adjustment_id generated (SA-001, etc.)
  - FIFO layers updated (remaining_quantity reduced)
  - stock_history rows created
  - product stock_levels updated
  - router.dismiss() → modal closes
  - Success toast: "Stock adjustment saved"
    ↓
Sync engine pushes to server
```

**Phase 1 — auto-approved:** In Phase 1 there is no approval workflow. Every manual adjustment is immediately applied to inventory when saved. The `status` field is set to `'approved'` on creation.

---

### 8.1 Location change after products added

```
Owner changes location after adding 3 line items
→ Alert: "Changing location will clear all products. Continue?"
  Cancel  → location reverts, line items kept
  Confirm → line items cleared, new location set
```

---

### 8.2 Date change after products added

```
Owner changes date after adding 3 line items
→ Alert: "Changing date will recalculate all quantities and costs. Continue?"
  Cancel  → date reverts, line items kept as-is
  Confirm → date updated, all line items recalculate
            (opening_quantity and unit_cost refresh from FIFO at the new date)
```

---

### 8.3 Unsaved changes guard

```
Form is dirty + owner tries to dismiss
→ Alert: "Discard changes?"
  Cancel  → stay on form
  Discard → dismiss modal, changes lost
```

---

## 9. Stock Adjustment edit flow

Only **Manual** adjustments can be edited. System-Generated adjustments are always read-only.

```
Owner taps Edit on a manual adjustment
    ↓
StockAdjustmentEditScreen opens as modal
    ↓
Locked fields (read-only):
  - Adjustment ID
  - Location (cannot change location on existing adjustment)
    ↓
Editable fields:
  - Date (triggers recalculation)
  - Reason
  - Description
  - All line items (Storage Area, Difference Quantity)
  - Can add new line items
  - Can delete existing line items
    ↓
Save → recalculates FIFO, updates stock_history and fifo_cost_layers
router.dismiss()
Success toast: "Stock adjustment updated"
```

---

## 10. Stock Adjustment delete flow

Only **Manual** adjustments can be deleted.

```
Check: Is this a System-Generated adjustment?
  → Error: "System adjustments cannot be deleted"
    ↓
Confirmation: "Delete this adjustment?
This will restore [X] units of stock. Cannot be undone."
    ↓
User confirms:
  → Soft delete: deleted_at = NOW()
  → FIFO layers restored (remaining_quantity increased back)
  → stock_history rows marked as reversed
  → Product stock levels updated
  → Sync engine sends delete to server
  → Success toast: "Adjustment deleted. Stock restored."
```

**Rollback is automatic:** Deleting an approved adjustment restores the inventory quantity and value back to the pre-adjustment state.

---

## 11. Stock Adjustments list screen

### 11.1 Screen structure

```
Route:   app/(store)/(main)/(tabs)/more/stock-adjustments/index.tsx
         (or a dedicated Stock tab — depending on navigation decisions)
Feature: features/stock-adjustments/screens/StockAdjustmentListScreen.tsx
```

### 11.2 Filters

- Date range
- Reason (All / Damaged / Stolen / Expired / Purchase / Sales / Stock Take / Transfer)
- Product search
- Manual only / All

### 11.3 List columns

| Column | Description |
|--------|-------------|
| Date | Adjustment date |
| Adjustment ID | SA-001, or parent ref (B-012, INV-034) for system-generated |
| Type | Manual / System |
| Reason | Damaged / Stolen / Expired / Purchase / Sales / etc. |
| Products | Count of line items |
| Total Qty | Sum of difference quantities across all line items |
| Total Value | Sum of difference values in ₹ |

### 11.4 Row actions (swipe or kebab)

| Action | Available for | Behaviour |
|--------|--------------|-----------|
| View | All | Opens read-only detail |
| Edit | Manual only | Opens edit modal |
| Delete | Manual only | Delete flow with rollback |

System-Generated adjustments show only View — Edit and Delete are hidden regardless of permission.

---

## 12. Stock History view

Stock History is the chronological ledger of every inventory movement for a product. It is the most important screen for the owner to understand what happened to their stock.

### 12.1 Entry points

- Product detail screen → "Stock History" button
- Stock Adjustment detail → line item → "View History"

### 12.2 Filters

- Product selector (pre-selected from entry point, switchable)
- Date range: Today / This Week / This Month / Last Month / Custom
- Location (if multi-location)
- Storage Area

### 12.3 Column definitions

| Column | Formula | Description |
|--------|---------|-------------|
| Date | Transaction date | When the movement occurred |
| Reference | Transaction ID | B-001, INV-034, SA-012, ST-003 |
| Type | Transaction type | Purchase, Sale, Manual Adj, Stock Take, Transfer, Return |
| Reason | Reason code | Damaged, Stolen, Expired, Purchase, Sales, etc. |
| Opening Balance | Previous closing balance | Stock before this transaction |
| Stock In | Qty received | Positive movement |
| Stock Out | Qty removed | Negative movement |
| Closing Balance | OB + In − Out | Stock after this transaction |
| Opening Value | Previous closing value (₹) | Value before transaction |
| Debit Value | Stock In × unit cost (₹) | Value added |
| Credit Value | Stock Out × FIFO cost (₹) | Value removed |
| Closing Value | OBV + Debit − Credit (₹) | Value after transaction |

**Negative values are highlighted in red.**

### 12.4 Transaction processing order (same date)

When multiple transactions fall on the same date, they are processed in this order:

```
1. Purchase-type (Bills, Expense receipts, Customer Credit Notes)
2. Sales-type (Invoices, Sales Receipts, Supplier Credit Notes)
3. Stock Take adjustments
4. Manual Adjustments (Damaged, Stolen, Expired)
```

This ensures FIFO layers are built before they are consumed within the same day.

### 12.5 FIFO Cost Distribution popup

When the owner taps any Stock Out row in the Stock History, a popup shows exactly which FIFO layers were consumed:

| Column | Description |
|--------|-------------|
| Purchase Date | When this batch was purchased |
| Reference | Bill number (B-001) |
| Dispense Qty | How many units from this batch were consumed |
| Unit Cost | ₹ per unit in this batch |
| Total Cost | Dispense Qty × Unit Cost |

Multiple rows appear when the adjustment consumed from multiple purchase batches. This is read-only — for audit and traceability.

### 12.6 Stock History display rules

- Manual Stock Adjustments appear in Stock History immediately (Phase 1 auto-approves)
- System-Generated adjustments appear as soon as the parent transaction is confirmed
- Deleted adjustments show as reversed (not removed) — the history row stays with a "Reversed" indicator
- Negative closing balances display in red

---

## 13. System-Generated adjustments

System-Generated adjustments are created automatically when parent transactions are processed. They provide the complete stock movement picture including purchases and sales.

### 13.1 Rules

| Rule | Description |
|------|-------------|
| Read-only | Cannot be edited by any user |
| Not deletable | Cannot be deleted by any user |
| No kebab edit/delete | Only "View" appears in the kebab menu |
| Auto-created | Created in the background when Bill/Invoice/Stock Take is saved |
| Linked | `parent_transaction_id` references the originating document |

### 13.2 Viewing parent transaction

On the System-Generated adjustment detail screen, the parent transaction reference (e.g., B-012) is tappable. Tapping navigates to the parent Bill, Invoice, or Stock Take in read-only view.

### 13.3 Why system-generated are read-only

If the owner needs to correct a System-Generated adjustment, they must correct the parent transaction (e.g., edit the Bill, void the Invoice). The adjustment will then be automatically recalculated. Allowing direct editing of system adjustments would create a discrepancy between the adjustment and its parent.

---

## 14. Stock Adjustment status lifecycle

**Phase 1 — simplified (no approval workflow):**

```
Manual:
  CREATE → auto-approved → APPROVED → (delete if needed) → DELETED

System-Generated:
  PARENT TRANSACTION SAVED → auto-created → APPROVED (permanent, cannot be deleted)
```

**Phase 2 — with approval workflow:**

```
Manual:
  CREATE → PENDING APPROVAL → (approver approves) → APPROVED
                             → (approver rejects)  → REJECTED → (edit + resubmit)
```

### 14.1 Status definitions

| Status | Description | Inventory impact |
|--------|-------------|-----------------|
| Approved | Adjustment is active and applied | Stock levels updated |
| Deleted | Manual adjustment removed and reversed | Stock levels restored |

---

## 15. RBAC — role-based access control

### 15.1 Permission matrix

| Action | Owner | Manager | Cashier |
|--------|-------|---------|---------|
| View adjustment list | ✅ | ✅ | ❌ |
| View adjustment detail | ✅ | ✅ | ❌ |
| Create manual adjustment | ✅ | ✅ | ❌ |
| Edit manual adjustment | ✅ | ✅ | ❌ |
| Delete manual adjustment | ✅ | ❌ | ❌ |
| View stock history | ✅ | ✅ | ❌ |
| Edit system-generated | ❌ | ❌ | ❌ (always blocked) |
| Delete system-generated | ❌ | ❌ | ❌ (always blocked) |

### 15.2 Enforcement

Cashiers never see stock adjustments or stock history. Stock is an operational/management concern — a cashier at the counter does not need to know the inventory value or adjustment history.

System-Generated adjustments are blocked from edit/delete at the **API level** — not just the UI. Even if a UI bug shows the Edit option, the server will reject the request.

---

## 16. Offline-first behaviour

| Operation | Offline |
|-----------|---------|
| View adjustment list | ✅ SQLite |
| View stock history | ✅ SQLite |
| Create manual adjustment | ✅ Saved locally, FIFO calculated locally, queued |
| Edit manual adjustment | ✅ Saved locally, FIFO recalculated, queued |
| Delete manual adjustment | ✅ Soft-deleted locally, rollback applied locally, queued |
| FIFO calculation | ✅ Runs entirely against local SQLite |

**Conflict risk:** If two devices create adjustments for the same product while offline, both will be applied when they sync. The server processes them in order of `adjustment_date` and `created_at`. The owner should check the Stock History after sync to verify the closing balance is correct.

---

## 17. Sync behaviour

### 17.1 Sync payload

```typescript
toSyncShape(adj: StockAdjustmentRow): StockAdjustmentSyncPayload {
  return {
    guuid:                    adj.guuid,
    adjustment_id:            adj.adjustment_id,
    adjustment_type:          adj.adjustment_type,
    parent_transaction_id:    adj.parent_transaction_id,
    parent_transaction_type:  adj.parent_transaction_type,
    location_id:              adj.location_id,
    adjustment_date:          adj.adjustment_date,
    reason_code:              adj.reason_code,
    description:              adj.description,
    status:                   adj.status,
    deleted_at:               adj.deleted_at,
    lines: lines.map(l => ({
      guuid:                  l.guuid,
      product_guuid:          l.product_guuid,
      storage_area:           l.storage_area,
      opening_quantity:       l.opening_quantity,
      difference_quantity:    l.difference_quantity,
      closing_quantity:       l.closing_quantity,
      unit_cost_paise:        l.unit_cost_paise,
      difference_value_paise: l.difference_value_paise,
      opening_value_paise:    l.opening_value_paise,
      closing_value_paise:    l.closing_value_paise,
    })),
  };
}
```

### 17.2 Entity applier

`src/infrastructure/sync/entity-appliers/stock-adjustment.ts` handles incoming server changes. On server push, the applier re-applies FIFO from server state to ensure both devices have identical closing balances.

---

## 18. Business rules — complete list

### Header rules

| Rule | Description |
|------|-------------|
| BR-SA-001 | Location must be selected before any other field enables |
| BR-SA-002 | Changing location after products clears all line items (with confirmation) |
| BR-SA-003 | Changing date after products triggers recalculation (with confirmation) |
| BR-SA-004 | Date must not be in the future |
| BR-SA-005 | Date must be after the store's first transaction date |
| BR-SA-006 | Reason is mandatory for all manual adjustments |

### Line item rules

| Rule | Description |
|------|-------------|
| BR-SA-010 | At least one line item required to save |
| BR-SA-011 | Storage Area is mandatory per line item |
| BR-SA-012 | Same product + same storage area cannot be added twice to same adjustment |
| BR-SA-013 | Same product + different storage area is allowed (creates separate lines) |
| BR-SA-014 | Difference Quantity must be > 0 for manual adjustments |
| BR-SA-015 | Closing Quantity can be negative (if store setting allows) |
| BR-SA-016 | Only inventory-tracked and quantity-tracked products are eligible |
| BR-SA-017 | Service products are never eligible |

### FIFO rules

| Rule | Description |
|------|-------------|
| BR-SA-020 | Manual adjustments use FIFO — oldest layers consumed first |
| BR-SA-021 | Unit cost is derived from FIFO layers, never user-entered |
| BR-SA-022 | If no FIFO layers exist, unit cost uses product's default case cost |
| BR-SA-023 | If no cost at all, unit cost = 0 (adjustment records quantity but no value) |
| BR-SA-024 | Deleting an adjustment restores FIFO layers (remaining_quantity increased) |

### System-Generated rules

| Rule | Description |
|------|-------------|
| BR-SA-030 | System-Generated adjustments cannot be edited by any user |
| BR-SA-031 | System-Generated adjustments cannot be deleted by any user |
| BR-SA-032 | To correct a System-Generated adjustment, correct the parent transaction |
| BR-SA-033 | Deleting a parent transaction reverses its System-Generated adjustment |

### Lifecycle rules

| Rule | Description |
|------|-------------|
| BR-SA-040 | Phase 1: all manual adjustments auto-approved on creation |
| BR-SA-041 | Soft delete with inventory rollback |
| BR-SA-042 | Adjustment ID permanently retired after deletion (never reused) |

---

## 19. Validation matrix

| Field | Rule | Error message |
|-------|------|---------------|
| Location | Required | "Location is required" |
| Date | Required | "Date is required" |
| Date | Future date | "Date cannot be in the future" |
| Reason | Required | "Reason is required" |
| Products | None added | "Add at least one product" |
| Storage Area | Empty per line | "Storage area is required" |
| Difference Qty | = 0 | "Quantity must be greater than zero" |
| Difference Qty | Negative | "Quantity must be greater than zero" |
| Difference Qty | Duplicate product+storage | "This product is already added for this storage area" |
| Description | > 250 chars | "Description cannot exceed 250 characters" |

---

## 20. Real-world scenarios

### Scenario 1 — Owner writes off expired Amul Butter

```
Owner opens More → Stock → Stock Adjustments → taps "+"
Location: Main Store
Date: today
Reason: Expired
Description: "Butter expired Jan 30, found during morning shelf check"

Taps Add Product → selects "Amul Butter 500g"
Storage Area: Fridge Section
  Opening Qty: 24 units
  Unit Cost: ₹200 (from oldest FIFO layer — Bill B-012 Jan 15)
Enters Difference Qty: 6 (6 units expired)
  Difference Value: 6 × ₹200 = ₹1,200
  Closing Qty: 24 − 6 = 18 units

Saves → adjustment SA-041 created
Stock History now shows:
  SA-041 | Expired | Stock Out 6 | Closing Balance: 18
```

---

### Scenario 2 — Theft discovered during end-of-day count

```
Owner closes shop and counts cash + stock
Notices Classmate Notebooks (Assorted) — system shows 80, physically 68
12 notebooks missing — suspected theft

Creates adjustment:
Reason: Stolen
Difference Qty: 12
Unit Cost: ₹38 (from FIFO)
Difference Value: 12 × ₹38 = ₹456

Description: "12 notebooks missing, reported to police, complaint #MUM20251231"
Saves → SA-042
```

---

### Scenario 3 — Flood damage in storage room

```
Heavy rain damages 3 products in the back storage area:

Adjustment 1:
  Product: Basmati Rice 5kg, Storage: Back Room
  Reason: Damaged
  Qty: 8 bags | Unit Cost: ₹450 | Value: ₹3,600

  (one adjustment can have multiple line items)
  Add second line item:
  Product: Cooking Oil 1L, Storage: Back Room
  Reason: Damaged
  Qty: 15 bottles | Unit Cost: ₹135 | Value: ₹2,025

  Add third line item:
  Product: Wheat Flour 10kg, Storage: Back Room
  Qty: 4 bags | Unit Cost: ₹340 | Value: ₹1,360

  Total Difference Value: ₹6,985
  Description: "Flood damage 15 Jan — back room"
  Saves → SA-043
```

---

### Scenario 4 — Owner views Stock History for Dove Shampoo

```
Owner is curious why stock of Dove Shampoo shows 32 units
but they thought they had 40 after the last purchase

Opens product detail for "Dove Shampoo 340ml" → Stock History
Date range: Last 30 days

History shows:
Date       Reference  Type          Stock In  Stock Out  Closing Balance
Dec 15     B-089      Purchase      50        —          50
Dec 20     INV-412    Sale          —         8          42
Dec 22     INV-418    Sale          —         2          40
Dec 28     SA-038     Expired       —         8          32  ← here

Owner sees SA-038 (8 units expired) explains the gap
Taps SA-038 → Stock Out row → FIFO Distribution popup:
  Dec 15 | B-089 | 8 units @ ₹118 = ₹944
  (all 8 came from the December 15 purchase)
```

---

### Scenario 5 — Deleting an incorrect adjustment

```
Owner accidentally entered Difference Qty: 12 instead of 2
for a Stolen adjustment on Colgate Toothpaste

Goes to Stock Adjustments list
Finds SA-044 (today)
Swipes left → Delete
Alert: "Delete this adjustment? 12 units of Colgate Toothpaste will be restored."
Confirms

→ SA-044 deleted
→ FIFO layers restored: 12 units back at their original cost
→ Stock History shows SA-044 as "Reversed"

Owner creates new adjustment SA-045 with correct qty: 2
```

---

## 21. Dos and don'ts

**Always use FIFO for unit cost, never let users enter cost manually.** Allowing manual cost entry would break inventory valuation integrity. The unit cost must always come from the FIFO layer calculation — this ensures the stock value on hand matches actual purchase history.

**Store all monetary values in paise (integer).** `unit_cost_paise = 20000` (₹200) not `unit_cost = 200.00`. Integer paise arithmetic is exact.

**Format Indian currency with `en-IN` locale.** ₹1,200 not ₹1200. `(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 })`.

**Never allow editing or deleting System-Generated adjustments at the API level.** Even if the UI hides the Edit button, enforce the block server-side. A System-Generated adjustment is a direct reflection of a parent transaction. Editing it would create an invisible discrepancy.

**Use "Expired" not "Out of Date" for reason codes.** Indian users say "expired" (expiry date on packaging). "Out of Date" is Irish/UK English.

**One adjustment can have multiple line items.** Do not force users to create separate adjustments for each damaged product. A flood or theft event typically affects multiple products — they should all be in one adjustment with one reason code and description.

**Closing Quantity can be negative — show it in red, do not block it.** Negative stock indicates a data problem (more stock was written off than the system recorded). Block it only if the store setting "Prevent Negative Inventory" is enabled. Otherwise show it in red and let the owner investigate.

**Transaction processing order matters within a day.** Purchases must be processed before sales and adjustments on the same date so FIFO layers are built before they are consumed. Follow the order: Purchases → Sales → Stock Takes → Manual Adjustments.

**Display the "Old quantity is tentative" warning.** Between when an adjustment is created and when it is confirmed, other transactions may affect the stock. The opening quantity shown may not match reality if purchases or sales occurred in the meantime. Show the warning note to avoid owner confusion.

---

## Appendix A — Reason codes

| Code | Type | Direction | Description |
|------|------|-----------|-------------|
| `damaged` | Manual | Stock Out | Goods physically damaged and cannot be sold |
| `stolen` | Manual | Stock Out | Goods lost due to theft |
| `expired` | Manual | Stock Out | Goods past expiry date |
| `purchase` | System | Stock In | Goods received via purchase bill |
| `sales` | System | Stock Out | Goods sold via invoice or receipt |
| `sales_return` | System | Stock In | Goods returned by customer |
| `purchase_return` | System | Stock Out | Goods returned to supplier |
| `stock_take_in` | System | Stock In | Stock take physical count adjustment (count > system) |
| `stock_take_out` | System | Stock Out | Stock take physical count adjustment (count < system) |
| `transfer_in` | System | Stock In | Goods received from another location/storage area |
| `transfer_out` | System | Stock Out | Goods sent to another location/storage area |
| `opening_balance` | System | Stock In | Initial stock entry for a new location |

---

*Document version: 1.0 — Ayphen Retail Mobile — Stock Adjustments*
*Adapted from: Stock Adjustment PRD v2.0 (Ayphen Books) for Indian retail POS context*
*Key adaptations: Phase 1 auto-approval (no multi-level workflow), INR-only, reason codes adapted to Indian retail, no GL journal entries*
