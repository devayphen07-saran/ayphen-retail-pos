# Stock Take — Ayphen Retail Mobile

Complete reference for the Stock Take module. Every field, every flow, every business rule, and every real-world scenario for Indian retail.

---

## Table of contents

1. [What this module does](#1-what-this-module-does)
2. [Stock Take types](#2-stock-take-types)
3. [Stock Take vs Stock Adjustment](#3-stock-take-vs-stock-adjustment)
4. [Data model — complete schema](#4-data-model--complete-schema)
5. [Field specifications — Header](#5-field-specifications--header)
6. [Field specifications — Product lines](#6-field-specifications--product-lines)
7. [Opening Balance Stock Take — complete specification](#7-opening-balance-stock-take--complete-specification)
8. [Submission options — the most important decision](#8-submission-options--the-most-important-decision)
9. [Inventory update logic](#9-inventory-update-logic)
10. [Stock Take create flow](#10-stock-take-create-flow)
11. [Stock Take edit flow](#11-stock-take-edit-flow)
12. [Stock Take delete flow](#12-stock-take-delete-flow)
13. [Stock Takes list screen](#13-stock-takes-list-screen)
14. [Stock Take detail screen](#14-stock-take-detail-screen)
15. [Stock Take status lifecycle](#15-stock-take-status-lifecycle)
16. [Product eligibility](#16-product-eligibility)
17. [RBAC — role-based access control](#17-rbac--role-based-access-control)
18. [Offline-first behaviour](#18-offline-first-behaviour)
19. [Sync behaviour](#19-sync-behaviour)
20. [Business rules — complete list](#20-business-rules--complete-list)
21. [Validation matrix](#21-validation-matrix)
22. [Real-world scenarios](#22-real-world-scenarios)
23. [Dos and don'ts](#23-dos-and-donts)

---

## 1. What this module does

A Stock Take is the act of physically walking through the store and counting every product. The counted quantities are then compared with what the system thinks is there, and the difference is adjusted. It is the ground truth of inventory — no amount of purchase bill tracking or sales recording replaces looking at the shelf and counting.

**What it enables:**
- Owner assigns a staff member to count specific products at a specific location
- System shows what it expects to find (Old Quantity) next to what was actually found (Counted Quantity)
- On submission, the system creates stock adjustment transactions for every difference
- Opening Balance Stock Take is used when a new kirana store owner first sets up the app — they count everything they have and set those quantities as the baseline with a cost price per product
- Stock History records every stock take as a transaction, maintaining the complete movement ledger

**What it does not do in Phase 1:**
- No multi-level approval workflow — every stock take is auto-approved on submission
- No concurrent stock take collision detection — owner must manage scheduling
- No predated transaction recalculation for historical stock takes
- No stock take import via CSV
- No cancellation of approved stock takes (Phase 2)

---

## 2. Stock Take types

### 2.1 Regular Stock Take

A periodic physical count of inventory. Used for:
- Weekly/monthly inventory audits
- Post-festival reconciliation (after Diwali sale stock was depleted rapidly)
- Investigating a suspected discrepancy (cashier scan errors, unrecorded pilferage)
- Random spot checks on high-value or fast-moving items

```
Examples:
  Monday morning count of all dairy products
  End-of-month full store count
  Spot check on premium FMCG items after a busy weekend
```

### 2.2 Opening Balance Stock Take

The very first stock entry when a store owner starts using the app. The owner counts everything in the store on the go-live date and sets each product's quantity AND cost price. This becomes the FIFO cost baseline — the first "purchase" layer in the inventory.

```
Example:
  Owner installs the app on January 1.
  Counts: Amul Butter 500g → 24 units → ₹220 per unit cost
  Counts: Basmati Rice 5kg → 8 bags → ₹450 per bag cost
  These quantities become the starting stock.
  These costs become the first FIFO layer for each product.
```

**One per location.** Once an opening balance is done for a location, the toggle disappears — the owner cannot create a second one. Different locations can each have their own opening balance.

---

## 3. Stock Take vs Stock Adjustment

| Aspect | Stock Take | Stock Adjustment |
|--------|-----------|-----------------|
| Trigger | Physical count reveals discrepancy | Owner already knows what was lost |
| Process | Count → compare → system adjusts | Owner directly specifies quantity to write off |
| Reason codes | Stock Take In / Stock Take Out | Damaged / Stolen / Expired |
| Zero counted | Valid — means product not found | Not applicable — Diff Qty must be > 0 |
| Direction | Can be Stock In or Stock Out | Always Stock Out (manual) |
| Use case | "Let me check what I have" | "I know 6 bottles broke, write them off" |

---

## 4. Data model — complete schema

```sql
-- Core stock take table
stock_takes (
  id                    INTEGER  PRIMARY KEY AUTOINCREMENT,
  guuid                 TEXT     NOT NULL UNIQUE,
  store_id              INTEGER  NOT NULL REFERENCES stores(id),

  -- Identity
  stock_take_id         TEXT     NOT NULL,               -- ST-001, ST-002
  is_opening_balance    INTEGER  NOT NULL DEFAULT 0,     -- 1 = opening balance take

  -- Header
  location_id           INTEGER  NOT NULL REFERENCES locations(id),
  take_date             TEXT     NOT NULL,               -- ISO date
  assigned_to_user_id   INTEGER  NOT NULL,               -- staff member who counted
  description           TEXT,                            -- 0–250 chars
  created_by_user_id    INTEGER  NOT NULL,

  -- Submission
  submission_option     TEXT,                            -- 'counted_only' | 'zero_remaining'
  effective_date        TEXT,                            -- ISO date — when adjustment is posted
  submitted_at          TEXT,                            -- ISO datetime

  -- Status
  status                TEXT     NOT NULL DEFAULT 'draft', -- 'draft'|'approved'|'deleted'

  -- Sync
  created_at            TEXT     NOT NULL,
  updated_at            TEXT     NOT NULL,
  deleted_at            TEXT,
  sync_status           TEXT     NOT NULL DEFAULT 'pending'
)

-- Product lines in a stock take
stock_take_lines (
  id                    INTEGER  PRIMARY KEY AUTOINCREMENT,
  guuid                 TEXT     NOT NULL UNIQUE,
  stock_take_guuid      TEXT     NOT NULL REFERENCES stock_takes(guuid),
  store_id              INTEGER  NOT NULL,

  product_guuid         TEXT     NOT NULL REFERENCES products(guuid),
  storage_area          TEXT,                            -- storage area within location

  -- Quantities
  old_quantity          REAL     NOT NULL DEFAULT 0,     -- system qty at take_date
  counted_quantity      REAL     NOT NULL DEFAULT 0,     -- physically counted qty

  -- Opening Balance only
  cost_price_paise      INTEGER,                         -- cost per unit (OB only)

  -- Values (paise) — calculated at submission
  old_value_paise       INTEGER  NOT NULL DEFAULT 0,     -- old_qty × cost_at_date
  new_value_paise       INTEGER  NOT NULL DEFAULT 0,     -- counted_qty × cost_price

  -- Sync
  created_at            TEXT     NOT NULL,
  sync_status           TEXT     NOT NULL DEFAULT 'pending'
)
```

---

## 5. Field specifications — Header

### 5.1 Stock Take ID

| Attribute | Value |
|-----------|-------|
| Type | Auto-generated |
| Format | ST-001, ST-002 (prefix configurable from store settings) |
| Uniqueness | Per store, permanent |
| Editable | Never |
| Stored as | `stock_take_id TEXT` |

Never reused after deletion. If ST-007 was deleted, the next stock take gets ST-008.

---

### 5.2 Location

| Attribute | Value |
|-----------|-------|
| Type | Dropdown |
| Mandatory | Yes |
| Source | Active locations for this store |
| Locked after save | YES — cannot change location after the stock take is saved |
| Stored as | `location_id INTEGER` |

**Location determines product availability.** Only products stocked at this location appear in the product selection. Changing location after adding products clears all lines (with confirmation alert).

---

### 5.3 Date

| Attribute | Value |
|-----------|-------|
| Type | Date picker |
| Mandatory | Yes |
| Default | Today |
| Range | Store go-live date to today |
| Future dates | Not allowed |
| Opening Balance | Auto-set to store go-live date and disabled |
| Locked after save | YES — cannot change date after saving |
| Stored as | `take_date TEXT` |

**Date affects Old Quantity.** The system calculates Old Quantity as the closing stock on the take_date. A different date gives different Old Quantities.

**Date is locked after save** (unlike Stock Adjustments where date can be changed). This is intentional — the physical count happened on a specific date and that date cannot be retroactively changed.

---

### 5.4 Assigned To

| Attribute | Value |
|-----------|-------|
| Type | Dropdown |
| Mandatory | Yes |
| Source | Active staff members mapped to the selected location |
| Editable | Yes (can reassign even after saving as draft) |
| Stored as | `assigned_to_user_id INTEGER` |

The assigned staff member is the person who physically walked the store and counted. They are responsible for the counted quantities. The Owner can always edit any stock take regardless of assignment.

---

### 5.5 Opening Balance Toggle

| Attribute | Value |
|-----------|-------|
| Type | Toggle |
| Default | OFF |
| Locked after save | YES — cannot unset once saved as opening balance |
| Visibility | Hidden for a location that already has an opening balance |
| Stored as | `is_opening_balance INTEGER` |

When ON:
- Date is forced to store go-live date and disabled
- Cost Price column appears on each product line (mandatory)
- Old Quantity is always shown as 0 (nothing in the system yet)

After saving with this toggle ON, the toggle is permanently locked and the Opening Balance indicator shows on this stock take forever.

---

### 5.6 Description

| Attribute | Value |
|-----------|-------|
| Type | Text area |
| Mandatory | No |
| Max length | 250 characters |
| Stored as | `description TEXT` |

Examples: "End of month January 2025 count", "Post-Diwali full store audit", "Opening balance — store opened Jan 1 2025".

---

## 6. Field specifications — Product lines

### 6.1 Add Product

Tapping "Add Product" opens a product selection popup showing all eligible products for the selected location. User selects one or multiple products and taps "Add to Stock Take". Selected products appear as rows.

**Product selection popup columns:**
- Product name and POS code/barcode
- Stock on Hand (current system quantity at this location)
- Unit of Measure (kg, L, units, etc.)

Multi-select: the owner can tick multiple products and add them all at once.

---

### 6.2 Storage Area (per line)

| Attribute | Value |
|-----------|-------|
| Type | Dropdown |
| Mandatory | Yes per product line |
| Source | Storage areas configured for selected location |
| Duplicate rule | Same product + same storage area not allowed |

**Same product, different storage areas = two separate lines.** The owner counted the product in two locations within the store — that is valid and must not be consolidated.

---

### 6.3 Old Quantity (per line)

| Attribute | Value |
|-----------|-------|
| Type | Read-only display |
| Source | System-calculated closing balance at `take_date` for this product + storage area |
| Editable | Never |
| Display | With unit suffix: "24 units", "3.5 kg" |

**Critical warning note — always display:**

> "Old quantity is tentative. If purchases or sales have been recorded since this stock take was created, the actual adjustment will be calculated from the current inventory at the time of submission — not from the old quantity shown here."

This is not a bug — it is expected behaviour. A stock take can sit in Draft for a week while the store continues operating. The old quantity shown when the owner created the take may no longer match the current system stock.

---

### 6.4 Old Value (per line)

| Attribute | Value |
|-----------|-------|
| Type | Read-only display |
| Formula | `old_quantity × unit_cost (from FIFO layers at take_date)` |
| Format | ₹X,XX,XXX |

Hidden for Opening Balance Stock Takes (old value is always ₹0 since there is nothing in the system yet).

---

### 6.5 Counted Quantity (per line)

| Attribute | Value |
|-----------|-------|
| Type | Numeric input |
| Mandatory | Yes per product line |
| Min value | 0 (zero is valid — product was not found during count) |
| Negative | Not allowed |
| Decimal | Allowed for Measure to Sell products (up to 3 decimal places) |
| Whole numbers | Required for unit-based products |
| Stored as | `counted_quantity REAL` |

**Zero is valid.** If the owner counted a product and found zero units (empty shelf), they enter 0. This will create a Stock Out adjustment equal to the system's current stock. "I couldn't find any" is meaningful information.

---

### 6.6 Cost Price (per line — Opening Balance only)

| Attribute | Value |
|-----------|-------|
| Type | Numeric (stored as paise) |
| Mandatory | Yes when `is_opening_balance = 1` |
| Min value | > 0 (cannot be zero) |
| Decimal | Up to 2 decimal places |
| Stored as | `cost_price_paise INTEGER` |
| Visibility | Only visible when Opening Balance Toggle is ON |

This becomes the first FIFO cost layer for each product. It represents what the owner paid (or estimates they paid) for the existing stock. If the owner doesn't know the exact cost, they should enter their best estimate — it affects profit margin calculations going forward.

**For products with multiple case quantities:** Use the cost from the Default case configuration. The product's `case_cost_paise ÷ (case_quantity × pack_size)` is the per-unit cost — this is pre-filled as a suggestion but the owner can change it.

---

### 6.7 Duplicate product + storage area prevention

```
Owner tries to add "Amul Butter 500g" + "Fridge Section" twice in the same stock take.

On the second attempt:
→ "Fridge Section" is disabled in the storage area dropdown for Amul Butter
→ The owner must add a different storage area (e.g., "Back Room")
   OR update the existing Amul Butter / Fridge Section line item

System does NOT auto-consolidate quantities.
```

---

## 7. Opening Balance Stock Take — complete specification

### 7.1 Why it exists

When an owner first installs the app, the system has no inventory data. Before they can start selling and tracking stock movements, they need to tell the system what they currently have. The Opening Balance Stock Take is that initial count.

Without an opening balance:
- Stock History starts from zero for everything
- FIFO layers have no baseline
- Profit margins cannot be calculated accurately
- The system doesn't know if the first sale depleted real stock or came from nothing

### 7.2 Creation rules

```
1. Owner opens More → Stock → Stock Takes → taps "+"
2. Selects location
3. Opening Balance toggle is visible (no prior opening balance for this location)
4. Toggles ON → date locks to store go-live date → Cost Price column appears
5. Adds products and enters counted quantities + cost prices
6. Saves as Draft (can add more products later)
7. When ready: taps "Submit"
8. Stock Take auto-approved
9. All counted quantities become the opening stock
10. All cost prices become the first FIFO layer per product
11. Opening Balance toggle is now hidden for this location — cannot create another
```

### 7.3 One-time restriction per location

| State | Opening Balance toggle |
|-------|----------------------|
| No opening balance for location | Toggle visible and selectable |
| Opening balance exists in Draft | Toggle hidden for this location |
| Opening balance exists Approved | Toggle hidden for this location |
| Opening balance was deleted | Toggle becomes visible again |

Different store locations (e.g., "Main Store" and "Branch") each need their own opening balance. Creating an opening balance for "Main Store" does not affect "Branch".

### 7.4 Opening Balance vs Regular Stock Take — key differences

| Aspect | Opening Balance | Regular Stock Take |
|--------|----------------|-------------------|
| Purpose | Initial stock baseline | Periodic verification |
| Frequency | Once per location | Unlimited |
| Date | Store go-live date (locked) | Any date from go-live to today |
| Cost Price | Required per product line | Hidden (not applicable) |
| Old Quantity | Always 0 | System calculated |
| Old Value | Always ₹0 | System calculated |
| FIFO impact | Creates first cost layer | Creates adjustment at existing cost |
| Adjustment type | Always Stock In | Stock In or Stock Out |

### 7.5 Store go-live date (equivalent of migration date)

The store go-live date is set during store setup. It represents the date the owner starts using Ayphen Retail Mobile. All transactions must be on or after this date. The Opening Balance Stock Take is always dated to the go-live date.

**Go-live date is locked** once set. Changing it (in Phase 2) would invalidate the Opening Balance Stock Take and require re-creation.

---

## 8. Submission options — the most important decision

When the owner taps "Submit" on a stock take, the system asks one question before processing:

> **"How would you like to update inventory?"**
>
> ○ Update counted products only
> ○ Update counted products + zero all remaining

This is the single most consequential decision in the stock take flow. Getting it wrong causes either incomplete reconciliation or mass zeroing of products.

---

### 8.1 Option 1 — Update Counted Quantity Only

**What it does:** Only the products included in this stock take have their inventory updated. Everything else in the system remains unchanged.

**Use this when:**
- This was a partial count (only counted some products today)
- Spot check on a specific category (only counted dairy products)
- Weekly rolling count (counted section A this week, section B next week)
- The owner did not count every product in the store

**Example:**

```
Store has 50 products.
Stock Take includes: Amul Butter (counted: 20), Dove Shampoo (counted: 15)

Result with "Update Counted Only":
  Amul Butter → updated to 20 (or adjusted to match 20)
  Dove Shampoo → updated to 15 (or adjusted to match 15)
  All other 48 products → UNCHANGED ← this is the key point
```

---

### 8.2 Option 2 — Update Counted + Zero Remaining

**What it does:** Products included in this stock take are updated to their counted quantities. ALL OTHER products at this location that were NOT included in the stock take are set to ZERO.

**Use this when:**
- This was a full store count (the owner counted everything)
- End-of-year complete stock take
- A product not counted is assumed to have zero stock

**The assumption:** If I didn't count it, it doesn't exist.

**Example:**

```
Store has 50 products.
Stock Take includes: Amul Butter (counted: 20), Dove Shampoo (counted: 15)

Result with "Zero Remaining":
  Amul Butter → updated to 20
  Dove Shampoo → updated to 15
  All other 48 products → SET TO ZERO ← massive impact
```

**Warning shown before submission:**

> "This will set inventory to zero for all products NOT included in this stock take at [Location Name]. This affects [X] additional products. Are you sure?"

---

### 8.3 Effective Date

| Attribute | Value |
|-----------|-------|
| Default | Stock take date (`take_date`) |
| Range | Store go-live date to today |
| Future dates | Not allowed |
| Opening Balance | Forced to go-live date and disabled |

The effective date is when the stock adjustment transactions are posted to the stock history. Usually this equals the take_date. The owner can choose a past date if they want the adjustment to be recorded on a specific historical date (e.g., they want the adjustment to show on the 30th of the month even though they're approving it on the 2nd of next month).

---

## 9. Inventory update logic

### 9.1 The calculation

For each product line in the stock take:

```
Adjustment Quantity = Counted Quantity − Current Inventory at submission time

(NOT at the time the stock take was created — at the time it is submitted)
```

This is the most important distinction. The owner may have created the stock take on Monday and submitted on Friday. Between Monday and Friday, 10 units of Amul Butter were sold. The system recalculates based on Friday's stock, not Monday's.

**Why this matters:**

```
Monday (stock take created):
  Old Quantity shown: 30 units
  Owner counts: 25 units
  Owner expects: stock out of 5 units

Friday (stock take submitted):
  Sales happened Tuesday–Friday: 8 units sold
  Current system stock: 30 − 8 = 22 units
  Counted: 25 units (the owner physically counted 25)
  Actual adjustment: 25 − 22 = +3 (Stock In)

Owner is surprised — they expected -5 but got +3
The warning note explains this.
```

### 9.2 Adjustment type scenarios

| Old Qty (shown) | Current Qty (at submission) | Counted Qty | Adjustment | Direction |
|----------------|----------------------------|-------------|------------|-----------|
| 30 | 30 | 35 | +5 | Stock In |
| 30 | 30 | 22 | −8 | Stock Out |
| 30 | 30 | 30 | 0 | No adjustment |
| 30 | 30 | 0 | −30 | Stock Out |
| 30 | 22 | 25 | +3 | Stock In (see example above) |

### 9.3 Zero adjustment rows

When Counted Quantity = Current Inventory at submission, no stock adjustment transaction is created for that line. The line is processed but silently produces no adjustment. This is correct — if nothing changed, nothing to record.

However, if "Update Counted Only" is selected, this zero-adjustment line still confirms that the product was counted and found to match. The owner's count is recorded even if no inventory change occurs.

### 9.4 FIFO costing for adjustments

Stock adjustments created by a stock take follow the same FIFO rules as manual adjustments:

- **Stock Out adjustment** (counted < current): oldest FIFO layers consumed first
- **Stock In adjustment** (counted > current): creates a new FIFO layer at the product's current cost

For Opening Balance Stock Takes:
- Cost price entered by owner → creates the first FIFO layer per product
- No prior layers to consume

---

## 10. Stock Take create flow

### 10.1 Phase 1 — simplified (no approval workflow)

```
Two-step process:

STEP 1: Create the header (saves as Draft)
STEP 2: Add products and submit
```

**Step 1 — Create header:**

```
Owner opens More → Stock → Stock Takes → taps "+"
    ↓
StockTakeCreatePopup appears (lightweight modal)
    ↓
Fields:
  Location (mandatory)
  Date (default: today, date picker)
  Assigned To (mandatory, dropdown of active staff)
  Opening Balance toggle (if location has no prior OB)
  Description (optional)
    ↓
Taps "Save"
    ↓
Stock take created in Draft status
stock_take_id generated: ST-001
Owner navigated to Stock Take detail screen
```

**Step 2 — Add products and submit:**

```
Stock Take detail screen open (Draft status)
    ↓
Taps "Add Product"
  → Product selection popup
  → Search / browse eligible products
  → Select products → "Add to Stock Take"
  → Product lines appear
    ↓
Per product line:
  → Select Storage Area (mandatory)
  → System displays Old Quantity (system stock at take_date)
  → System displays Old Value
  → Enter Counted Quantity (≥ 0)
  → If Opening Balance: Enter Cost Price (> 0)
    ↓
Taps "Submit"
    ↓
Submission popup appears:
  "How would you like to update inventory?"
  ○ Update counted products only
  ○ Update counted products + zero all remaining
  Date: [effective_date picker, default: take_date]
    ↓
If "Zero Remaining" selected:
  Warning: "This will zero out [X] products not counted at [Location]"
    ↓
Taps "Confirm"
    ↓
Validation:
  - At least one product line
  - All lines have Storage Area
  - All Counted Quantities entered (≥ 0)
  - Cost Price > 0 on all lines if Opening Balance
  - Effective date not in future
    ↓
If validation passes:
  - Stock take status → Approved
  - Adjustment = Counted − Current Inventory (calculated now)
  - System-Generated stock adjustments created for each line
  - If "Zero Remaining": additional stock adjustments for non-counted products
  - FIFO layers updated
  - Stock History updated
  - Success toast: "Stock take submitted. [X] products updated."
```

---

### 10.2 Saving as Draft without submitting

The owner can save the stock take in Draft and come back later to add more products or adjust quantities. The stock take ID is already generated. No inventory impact until submission.

```
Owner adds 10 products to the stock take
Saves (auto-saves Draft on each line edit)
Closes the app
Returns tomorrow
Opens ST-007 (Draft)
Adds 5 more products
Reviews all quantities
Submits
```

---

## 11. Stock Take edit flow

Stock Takes can be edited only in **Draft** status.

```
Owner opens Draft stock take
    ↓
All fields editable EXCEPT:
  - Location (locked after save — clearing requires deleting all lines)
  - Date (locked after save)
  - Opening Balance toggle (locked after save)
    ↓
Owner can:
  - Change Assigned To
  - Change Description
  - Add new product lines
  - Remove existing product lines
  - Change Storage Area on a line
  - Change Counted Quantity
  - Change Cost Price (Opening Balance lines)
    ↓
Changes auto-save (or Save button)
    ↓
No inventory impact until submission
```

**Approved stock takes are completely read-only.** No edit option appears in the More menu. This is different from Stock Adjustments, which can be edited after approval.

---

## 12. Stock Take delete flow

```
Delete allowed only in Draft status
    ↓
Check: Is this Approved?
  → Error: "Approved stock takes cannot be deleted"

Check: Is this in Pending Approval? (Phase 2)
  → Error: "Cannot delete a stock take pending approval"
    ↓
If Draft:
  Confirmation: "Delete [ST-007]? This cannot be undone."
  Owner confirms
  → Soft delete: deleted_at = NOW()
  → stock_take_id permanently retired
  → If this was an Opening Balance stock take: Opening Balance toggle
    becomes available again for this location
  → No inventory impact (no inventory was ever posted for Draft)
    ↓
Success toast: "Stock take deleted"
```

**Opening Balance deletion re-enables the toggle.** If the owner deletes their opening balance stock take (while it's still Draft), they can create a new one. This allows them to correct mistakes before the opening balance is approved.

---

## 13. Stock Takes list screen

### 13.1 Screen structure

```
Route:   app/(store)/(main)/(tabs)/more/stock-takes/index.tsx
Feature: features/stock-takes/screens/StockTakeListScreen.tsx
Stack:   Inside more/ Stack — tab bar HIDDEN
```

### 13.2 Filters and search

- Date range
- Location filter
- Status: All / Draft / Approved
- Search: by stock take ID, description, assigned staff name

### 13.3 List columns

| Column | Description |
|--------|-------------|
| Date | Take date |
| Stock Take ID | ST-001 |
| Location | Where the count was done |
| Assigned To | Staff member who counted |
| Product Count | Number of product lines |
| Status | Draft / Approved |
| OB indicator | Small badge if opening balance |

### 13.4 Row actions (swipe or kebab)

| Action | Available for | Behaviour |
|--------|--------------|-----------|
| View | All | Read-only detail |
| Edit / Update | Draft only | Opens edit screen |
| Submit | Draft only (has products) | Submission popup |
| Delete | Draft only | Delete with confirmation |

Approved stock takes show only View — no Edit, no Delete.

---

## 14. Stock Take detail screen

```
Route:   app/(store)/(main)/(tabs)/more/stock-takes/[guuid]/index.tsx
Feature: features/stock-takes/screens/StockTakeDetailScreen.tsx
Stack:   Inside more/ Stack — tab bar HIDDEN
```

**Header section:**
- Stock Take ID, Date, Location, Status badge, Opening Balance badge (if applicable)
- Assigned To (tappable — shows staff profile)
- Description

**Product lines section (for Draft — editable):**
- Add Product button
- Each row: product name, storage area dropdown, old qty (read-only), counted qty (input), cost price (input, OB only)
- Delete row icon (no confirmation)

**Product lines section (for Approved — read-only):**
- Each row: product name, storage area, old qty, counted qty, adjustment qty, adjustment direction
- "View Stock History" link per row → opens stock history for that product

**Action buttons:**
- Draft: "Submit" (primary) + "Delete" (secondary)
- Approved: No action buttons

---

## 15. Stock Take status lifecycle

**Phase 1 — simplified:**

```
DRAFT → (owner submits) → APPROVED (permanent)
DRAFT → (owner deletes) → DELETED
```

There is no Pending Approval, no Rejected in Phase 1. The moment the owner submits, the stock take is approved and inventory is updated.

### 15.1 Status definitions

| Status | Description | Editable | Deletable | Inventory |
|--------|-------------|----------|-----------|-----------|
| Draft | Created, products being added, not yet submitted | Yes | Yes | No impact |
| Approved | Submitted and inventory updated | No | No | Updated |
| Deleted | Draft was permanently removed | N/A | N/A | No impact |

### 15.2 Phase 2 status expansion

When a manager/supervisor approval workflow is added (Phase 2):

```
DRAFT → PENDING APPROVAL → APPROVED
                          → REJECTED → (edit + resubmit) → DRAFT
```

The schema `status` field is already designed to support this. Phase 2 adds Pending Approval and Rejected states without schema migration.

---

## 16. Product eligibility

### 16.1 Eligible products

| Rule | Description |
|------|-------------|
| `product_type = 'goods'` | Physical goods only |
| `track_inventory = 1` OR `track_quantity = 1` | Must have inventory or quantity tracking enabled |
| `is_active = 1` | Active products only |

### 16.2 Ineligible products (filtered out of selection popup)

| Product | Why excluded |
|---------|-------------|
| Services | No physical stock |
| Non-trackable goods | `track_inventory = 0` AND `track_quantity = 0` |
| Inactive products | Cannot be transacted |
| Digital goods | No physical form |

**The same eligibility rules apply as in Stock Adjustments.** If a product appears in stock adjustments, it appears in stock takes.

---

## 17. RBAC — role-based access control

### 17.1 Permission matrix

| Action | Owner | Manager | Cashier |
|--------|-------|---------|---------|
| View stock take list | ✅ | ✅ | ❌ |
| View stock take detail | ✅ | ✅ | ❌ |
| Create stock take | ✅ | ✅ | ❌ |
| Edit draft stock take | ✅ | ✅ (if assigned) | ❌ |
| Edit another's stock take | ✅ | ❌ | ❌ |
| Submit stock take | ✅ | ✅ (if assigned) | ❌ |
| Delete draft stock take | ✅ | ✅ (if assigned) | ❌ |
| Create opening balance | ✅ | ❌ | ❌ |

### 17.2 Assignment-based editing

A manager can only edit a stock take that is assigned to them. The owner can edit any stock take regardless of assignment. This prevents one staff member from altering another's count.

**Assigned user actions:**
- Can add/remove products
- Can enter counted quantities
- Can submit
- Can delete (if Draft)

**Non-assigned manager:**
- Can view only
- Cannot edit or submit

### 17.3 Opening Balance restriction

Only the **Owner** can create an Opening Balance Stock Take. This is a financial baseline-setting operation — it affects all future profit margin calculations and should not be delegated.

---

## 18. Offline-first behaviour

| Operation | Offline |
|-----------|---------|
| View stock take list | ✅ SQLite |
| View stock take detail | ✅ SQLite |
| Create stock take (header) | ✅ Saved locally, queued |
| Add product lines | ✅ Saved locally |
| Enter counted quantities | ✅ Saved locally |
| Submit stock take | ✅ Adjustments created locally, queued for sync |
| Delete draft stock take | ✅ Soft-deleted locally, queued |
| FIFO calculation at submission | ✅ Runs against local SQLite |
| Old Quantity display | ✅ Calculated from local stock_history |

**Concurrent submission risk:** If two devices submit stock takes for the same product offline and both sync later, the last sync wins. The owner should ensure only one device submits a stock take for a given location at a time. Phase 2 will add server-side conflict detection.

---

## 19. Sync behaviour

### 19.1 Sync payload

```typescript
toSyncShape(take: StockTakeRow, lines: StockTakeLineRow[]): StockTakeSyncPayload {
  return {
    guuid:                take.guuid,
    stock_take_id:        take.stock_take_id,
    is_opening_balance:   take.is_opening_balance,
    location_id:          take.location_id,
    take_date:            take.take_date,
    assigned_to_user_id:  take.assigned_to_user_id,
    description:          take.description,
    submission_option:    take.submission_option,
    effective_date:       take.effective_date,
    status:               take.status,
    deleted_at:           take.deleted_at,
    lines: lines.map(l => ({
      guuid:              l.guuid,
      product_guuid:      l.product_guuid,
      storage_area:       l.storage_area,
      old_quantity:       l.old_quantity,
      counted_quantity:   l.counted_quantity,
      cost_price_paise:   l.cost_price_paise,
    })),
  };
}
```

### 19.2 Opening Balance sync

The server treats an approved Opening Balance Stock Take as the authoritative starting point for all FIFO calculations for that product + location. On initial sync for a new device, the opening balance is the first record downloaded before any other stock history.

---

## 20. Business rules — complete list

### Identity and header

| Rule | Description |
|------|-------------|
| BR-ST-001 | Stock Take ID auto-generated, never manually editable, never reused |
| BR-ST-002 | Location is mandatory and locked after save |
| BR-ST-003 | Date is mandatory and locked after save |
| BR-ST-004 | Date cannot be in the future |
| BR-ST-005 | Date cannot be before store go-live date |
| BR-ST-006 | Assigned To is mandatory |
| BR-ST-007 | Opening Balance toggle is locked after save |
| BR-ST-008 | Opening Balance toggle hidden for locations that already have one |
| BR-ST-009 | Deleting an OB Draft stock take re-enables the toggle for that location |

### Opening Balance

| Rule | Description |
|------|-------------|
| BR-OB-001 | Only one Opening Balance per location at any time |
| BR-OB-002 | Opening Balance date is forced to store go-live date and disabled |
| BR-OB-003 | Cost Price is mandatory for every product line in Opening Balance |
| BR-OB-004 | Cost Price must be > 0 |
| BR-OB-005 | Old Quantity is always 0 in Opening Balance (nothing in system yet) |
| BR-OB-006 | Opening Balance creates the first FIFO layer for each product |
| BR-OB-007 | Only Owner role can create Opening Balance stock takes |

### Product lines

| Rule | Description |
|------|-------------|
| BR-ST-010 | At least one product line required before submission |
| BR-ST-011 | Storage Area mandatory per product line |
| BR-ST-012 | Same product + same storage area not allowed in same stock take |
| BR-ST-013 | Same product + different storage areas allowed (separate lines) |
| BR-ST-014 | Counted Quantity ≥ 0 (zero is valid) |
| BR-ST-015 | Counted Quantity negative values blocked |
| BR-ST-016 | Decimal quantities allowed for Measure to Sell products |
| BR-ST-017 | Whole numbers only for unit-based products |
| BR-ST-018 | Only inventory-tracked and quantity-tracked products eligible |
| BR-ST-019 | Service products excluded from product selection |

### Submission

| Rule | Description |
|------|-------------|
| BR-ST-020 | Submission option (counted only / zero remaining) is mandatory |
| BR-ST-021 | Effective date cannot be in the future |
| BR-ST-022 | Effective date defaults to take_date |
| BR-ST-023 | Adjustment = Counted Quantity − Current Inventory at submission time |
| BR-ST-024 | Zero-adjustment lines produce no stock adjustment transaction |
| BR-ST-025 | "Zero Remaining" sets all non-counted products at location to 0 |
| BR-ST-026 | "Zero Remaining" shows count of affected products before confirmation |

### Lifecycle

| Rule | Description |
|------|-------------|
| BR-ST-030 | Draft stock takes are fully editable |
| BR-ST-031 | Approved stock takes are completely read-only |
| BR-ST-032 | Only Draft stock takes can be deleted |
| BR-ST-033 | Approved stock takes cannot be deleted |
| BR-ST-034 | Phase 1: all stock takes auto-approved on submission |
| BR-ST-035 | Soft delete: stock_take_id permanently retired |

---

## 21. Validation matrix

| Field | Rule | Error message |
|-------|------|---------------|
| Location | Required | "Location is required" |
| Date | Required | "Date is required" |
| Date | Future date | "Date cannot be in the future" |
| Date | Before go-live | "Date cannot be before your store go-live date" |
| Assigned To | Required | "Assigned to is required" |
| Products | None added before submit | "Add at least one product before submitting" |
| Storage Area | Empty per line | "Storage area is required" |
| Counted Quantity | Not entered | "Counted quantity is required" |
| Counted Quantity | Negative | "Counted quantity cannot be negative" |
| Counted Quantity | Duplicate product+storage | "This product is already added for this storage area" |
| Cost Price (OB) | Not entered | "Cost price is required for opening balance" |
| Cost Price (OB) | Zero | "Cost price must be greater than zero" |
| Effective Date | Future date | "Effective date cannot be in the future" |
| Submission Option | Not selected | "Select how you want to update inventory" |
| Delete | Approved stock take | "Approved stock takes cannot be deleted" |

---

## 22. Real-world scenarios

### Scenario 1 — Opening Balance when owner first sets up the store

```
Owner Suresh installs Ayphen Retail Mobile on January 1, 2025.
Store go-live date: January 1, 2025.

Creates Opening Balance Stock Take:
  Location: Main Store
  Date: Jan 1 (locked to go-live date)
  Opening Balance: ON
  Assigned To: Suresh (himself)
  Description: "Opening stock count — store setup day"

Adds products:
  Amul Butter 500g    | Fridge     | Counted: 24 | Cost: ₹220/unit
  Basmati Rice 5kg    | Shelf A    | Counted: 8  | Cost: ₹450/bag
  Dove Shampoo 340ml  | Shelf B    | Counted: 36 | Cost: ₹285/bottle
  ... (continues for all 120 products in the store)

Submits:
  → Submission option: "Update counted + zero remaining"
     (because this is a full count — everything not listed is 0)
  → Effective Date: Jan 1
  → Confirms warning: "This will zero 0 additional products"
     (there are no other products in the system yet — correct)

Result:
  24 units of Amul Butter in inventory (FIFO layer: 24 @ ₹220 = ₹5,280)
  8 bags of Basmati Rice (FIFO layer: 8 @ ₹450 = ₹3,600)
  36 bottles Dove Shampoo (FIFO layer: 36 @ ₹285 = ₹10,260)
  ...

Stock History shows:
  Jan 1 | ST-001 | Opening Balance | Stock In: 24 | Closing: 24 | Value: ₹5,280
  (for each product)
```

---

### Scenario 2 — End of month stock take (partial count)

```
Owner Suresh does a monthly count of dairy and FMCG on January 31.

Creates Stock Take:
  Date: Jan 31
  Assigned To: Ravi (store assistant)
  Description: "January month-end dairy + FMCG count"

Ravi counts 15 products:
  Amul Butter 500g | Fridge | Counted: 18 (System: 22 → 4 sold since OB)
  Amul Milk 500ml  | Fridge | Counted: 30 (System: 30 → exact match)
  ...

Suresh submits:
  → "Update counted products only"
     (because only 15 of 120 products were counted)
  → Effective Date: Jan 31

Result:
  Amul Butter adjusted: 22 → 18 (stock out of 4 = discrepancy)
  Amul Milk: 30 → 30 (no adjustment — exact match)
  Remaining 105 products: UNCHANGED

Stock History shows:
  Jan 31 | ST-002 | Stock Take Out | -4 | Closing: 18
  (for Amul Butter only — Amul Milk shows no adjustment)
```

---

### Scenario 3 — Full year-end count

```
December 31, 2025.
Owner wants to do a complete count of all 200 products in the store.
Assigns to self and two staff members.

3 separate stock takes for different sections:
  ST-015: Dairy and Cold Section (assigned to Ravi) — 40 products
  ST-016: Dry Goods and Grains (assigned to Priya) — 80 products
  ST-017: FMCG and Cleaning (assigned to Suresh) — 80 products

Each submitted with "Update Counted Only" (because only their section)

Final picture: all 200 products have been counted across 3 stock takes.
No single "zero remaining" needed — the combination covers everything.
```

---

### Scenario 4 — The tentative quantity warning matters

```
Monday:
  Owner creates stock take for Dove Shampoo.
  Old Quantity shown: 12 bottles.
  Owner counts: 10 bottles.
  Expects: -2 adjustment.

Tuesday–Thursday:
  8 bottles of Dove Shampoo sold (3 regular sales).
  System now shows: 12 - 8 = 4 bottles.

Friday:
  Owner submits the stock take.
  Counted: 10 bottles.
  Current system stock: 4 bottles.
  Actual adjustment: 10 - 4 = +6 (Stock In!)

Owner is confused — expected -2 but got +6.

The warning note on the screen explains:
"Old quantity is tentative. Adjustment is calculated from current
inventory at submission time — not from the quantity shown above."

Interpretation: The owner counted 10 but the system only expects 4
(because 8 were sold). Means there were actually MORE bottles than
the system thought before the sales. Someone must have received
a delivery that wasn't recorded.
```

---

### Scenario 5 — Owner deletes and recreates Opening Balance

```
Owner creates Opening Balance Stock Take (ST-001, Draft)
Enters quantities and cost prices for 50 products

Realizes they entered wrong cost prices for 20 products.

Options:
  a) Edit the existing Draft → fix the wrong cost prices (simplest)
  b) Delete and recreate (if too many errors)

Owner chooses option b:
  Swipes to delete ST-001 (Draft) → confirms
  Opening Balance toggle is now available again for Main Store
  Creates new ST-002 with correct cost prices
  Submits → approved
  ST-002 is the canonical opening balance for Main Store
```

---

## 23. Dos and don'ts

**Always display the "Old quantity is tentative" warning.** Do not remove it to simplify the UI. Owners need to understand why the adjustment amount differs from their mental calculation. This confusion is the single biggest source of support tickets for stock take modules.

**Pre-fill Cost Price from the product's Default case cost.** For opening balance, the owner should not have to type the cost from scratch. Pre-fill from `case_cost_paise ÷ (case_quantity × pack_size)` and let them correct it if needed. Most times the pre-fill is right.

**Lock location and date after first save, not after submission.** The physical count happened at a specific location on a specific date. These two fields are ground truth. If the owner needs to change them, they must delete the stock take and create a new one.

**Show product count in the stock take list row.** "ST-003 — 47 products" is more useful than just "ST-003". The owner needs to know at a glance how complete a stock take is.

**Zero is a valid counted quantity — never block it.** An empty shelf is real information. The owner found zero bottles of shampoo. That is different from "I didn't count shampoo". Zero means counted and found nothing. Do not show a validation error for zero.

**"Zero Remaining" requires explicit confirmation with product count.** Never silently zero out products. Always show "This will zero out 47 products that were not counted at Main Store" before confirming. The impact is too large to be accidental.

**Opening Balance should only be created by the Owner.** The cost prices set in an opening balance directly affect every profit margin calculation for every product going forward. This is a one-time financial configuration, not a routine operation.

**Store cost_price_paise as integer paise.** `cost_price_paise = 22000` (₹220) not `cost_price = 220.00`. Consistent with all monetary values across the app.

**Format all quantities with unit suffixes.** Display "24 units" not just "24", "3.5 kg" not just "3.5". The unit context matters when the owner is looking at multiple products with different UoMs in the same list.

**Approved stock takes are permanent — no undo.** If the owner submitted with wrong quantities, they must create a new stock take or a manual stock adjustment to correct the error. Allowing edits to approved stock takes would make the Stock History unreliable.

---

*Document version: 1.0 — Ayphen Retail Mobile — Stock Takes*
*Adapted from: Stock Take PRD v1.0 (Ayphen ERP) for Indian retail POS context*
*Key adaptations: Phase 1 auto-approval (no multi-level workflow), INR-only paise storage, Indian kirana Opening Balance scenarios, simplified to two statuses (Draft / Approved), go-live date replaces migration date terminology*
