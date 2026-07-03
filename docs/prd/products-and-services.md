# Products & Services — Ayphen Retail Mobile

Complete reference for the Products and Services module. Every field, every flow, every business rule, every real-world scenario for Indian retail.

---

## Table of contents

1. [What this module does](#1-what-this-module-does)
2. [Product types](#2-product-types)
3. [Data model — complete schema](#3-data-model--complete-schema)
4. [Field specifications — General Information](#4-field-specifications--general-information)
5. [Field specifications — Inventory Configuration](#5-field-specifications--inventory-configuration)
6. [Field specifications — Volume and Weight](#6-field-specifications--volume-and-weight)
7. [Field specifications — Purchase Configuration](#7-field-specifications--purchase-configuration)
8. [Field specifications — Case Quantity Management](#8-field-specifications--case-quantity-management)
9. [Field specifications — Sales Configuration](#9-field-specifications--sales-configuration)
10. [Field specifications — Selling Price and Profit Margin](#10-field-specifications--selling-price-and-profit-margin)
11. [Field specifications — Location and Storage](#11-field-specifications--location-and-storage)
12. [Field specifications — Notes and Attachments](#12-field-specifications--notes-and-attachments)
13. [Form behaviour — how fields interact](#13-form-behaviour--how-fields-interact)
14. [Product create flow](#14-product-create-flow)
15. [Product edit flow](#15-product-edit-flow)
16. [Product delete flow](#16-product-delete-flow)
17. [Product clone flow](#17-product-clone-flow)
18. [Barcode scanner → product create flow](#18-barcode-scanner--product-create-flow)
19. [Products list screen](#19-products-list-screen)
20. [RBAC — role-based access control](#20-rbac--role-based-access-control)
21. [Offline-first behaviour](#21-offline-first-behaviour)
22. [Sync behaviour](#22-sync-behaviour)
23. [Business rules — complete list](#23-business-rules--complete-list)
24. [Validation matrix](#24-validation-matrix)
25. [Real-world scenarios](#25-real-world-scenarios)
26. [Dos and don'ts](#26-dos-and-donts)

---

## 1. What this module does

The Products and Services module is the product catalogue for an Indian retail POS. Every sale, every stock movement, every profit margin calculation in the app depends on a product record being correct.

**What it enables:**
- A kirana store owner creates products once and sells them repeatedly from the POS tab
- Products carry their tax rates (GST %) so every invoice is GST-compliant without manual calculation
- Stock is tracked in real time so the cashier knows when to reorder
- Profit margin is auto-calculated on every product so the owner knows if a product is worth selling
- MRP is stored per product so the cashier can never accidentally sell above the legal maximum

**What it does not do:**
- No general ledger account mapping (this is a POS, not accounting software)
- No multi-currency (INR only)
- No product variants (shirt in S/M/L) — separate future module
- No bill of materials / manufacturing — separate future module
- No supplier portal integration — separate future module

---

## 2. Product types

### 2.1 Goods

Physical products that exist in the store and can be tracked in inventory.

```
Examples: Amul Butter 500g, Coca-Cola 330ml, Basmati Rice 5kg,
          Classmate Notebook A4, Dove Shampoo 340ml
```

**Available features:**
- Inventory tracking (Track Inventory toggle)
- Quantity tracking (Track Quantity toggle)
- Barcode scanning
- Stock levels per location
- Weight and volume specifications

**GST treatment:** Standard GST rates (0%, 5%, 12%, 18%, 28%)

---

### 2.2 Services

Non-physical services delivered to customers. Cannot be inventoried.

```
Examples: Home delivery fee, Installation charge, Gift wrapping,
          Repair service, Consultation
```

**Available features:**
- Purchase and sales configuration
- Pricing (hourly, per-visit, per-job)
- Location availability

**Restrictions:**
- Track Inventory toggle is HIDDEN — services cannot be inventoried
- Track Quantity toggle is HIDDEN
- No stock levels

---

### 2.3 Digital Goods

Physical goods sold in electronic form (future use — schema-ready).

```
Examples: Recharge vouchers, Gift cards, Software licence keys
```

---

### 2.4 Goods vs Service — key differences at a glance

| Feature | Goods | Service |
|---------|-------|---------|
| Track Inventory | ✅ Available | ❌ Hidden |
| Track Quantity | ✅ Available | ❌ Hidden |
| Barcode | ✅ Default ON | ✅ Default OFF |
| MRP field | ✅ Required | ❌ Not applicable |
| HSN Code | ✅ Default shown | ✅ Optional |
| Weight | ✅ Available | ✅ Available (service may ship materials) |
| Measure to Sell | ✅ Available | ✅ Available (e.g., consulting hours) |
| GST Rate | ✅ Required if We Sell ON | ✅ Required if We Sell ON |
| We Buy toggle | ✅ Available | ✅ Available |
| We Sell toggle | ✅ Available | ✅ Available |

---

## 3. Data model — complete schema

```sql
-- Core product table
products (
  id                    INTEGER  PRIMARY KEY AUTOINCREMENT,
  guuid                 TEXT     NOT NULL UNIQUE,           -- UUID v4, global ID
  store_id              INTEGER  NOT NULL REFERENCES stores(id),

  -- Identity
  name                  TEXT     NOT NULL,                  -- 3–100 chars, unique per store
  description           TEXT,                               -- 0–250 chars
  product_type          TEXT     NOT NULL DEFAULT 'goods',  -- 'goods' | 'service'
  is_digital            INTEGER  NOT NULL DEFAULT 0,        -- boolean

  -- Unique identifiers
  barcode               TEXT,                               -- user-entered, unique per store
  pos_code              TEXT,                               -- auto-generated, permanent, never reused
  is_barcoded           INTEGER  NOT NULL DEFAULT 1,        -- 1 = use barcode, 0 = use pos_code

  -- Classification
  category_lookup_fk    INTEGER  REFERENCES lookups(id),
  hsn_code              TEXT,                               -- 4–8 digits for Indian GST

  -- Status
  is_active             INTEGER  NOT NULL DEFAULT 1,
  is_we_sell_this_item  INTEGER  NOT NULL DEFAULT 1,        -- appears in POS grid
  is_we_buy_this_item   INTEGER  NOT NULL DEFAULT 1,        -- appears in purchase flows

  -- Inventory
  track_inventory       INTEGER  NOT NULL DEFAULT 0,        -- full inventory accounting
  track_quantity        INTEGER  NOT NULL DEFAULT 0,        -- quantity visible without accounting

  -- Volume and weight
  is_measure_to_sell    INTEGER  NOT NULL DEFAULT 0,        -- fractional qty allowed
  volume_unit           TEXT,                               -- 'kg'|'g'|'l'|'ml'|'m'|'cm'|'unit'
  volume_amount         REAL,                               -- up to 3 decimal places
  weight_kg             REAL,                               -- for shipping
  pack_size             INTEGER  DEFAULT 1,                 -- units per pack (Pack Value)

  -- Purchase tax
  purchase_tax_rate_fk  INTEGER  REFERENCES tax_rates(id),

  -- Sales tax
  sales_tax_rate_fk     INTEGER  REFERENCES tax_rates(id),

  -- Pricing
  selling_price_paise   INTEGER  DEFAULT 0,                 -- current effective price
  selling_price_inclusive INTEGER NOT NULL DEFAULT 1,       -- 1 = price includes GST

  -- MRP (Legal Metrology Act — India)
  mrp_paise             INTEGER,                            -- Maximum Retail Price, inclusive

  -- Image
  image_uri             TEXT,                               -- local file path or remote URL

  -- Notes
  notes                 TEXT,                               -- 0–250 chars

  -- Sync
  created_at            TEXT     NOT NULL,
  updated_at            TEXT     NOT NULL,
  deleted_at            TEXT,                               -- soft delete
  sync_status           TEXT     NOT NULL DEFAULT 'pending'
)

-- Price history (effective-date pricing)
product_price_history (
  id                    INTEGER  PRIMARY KEY AUTOINCREMENT,
  guuid                 TEXT     NOT NULL UNIQUE,
  product_guuid         TEXT     NOT NULL REFERENCES products(guuid),
  store_id              INTEGER  NOT NULL,
  price_paise           INTEGER  NOT NULL,
  effective_from        TEXT     NOT NULL,                  -- ISO datetime
  is_inclusive          INTEGER  NOT NULL DEFAULT 1,        -- includes GST
  created_at            TEXT     NOT NULL,
  sync_status           TEXT     NOT NULL DEFAULT 'pending'
)

-- Case quantities (Unit → Pack → Case hierarchy)
product_cases (
  id                    INTEGER  PRIMARY KEY AUTOINCREMENT,
  guuid                 TEXT     NOT NULL UNIQUE,
  product_guuid         TEXT     NOT NULL REFERENCES products(guuid),
  store_id              INTEGER  NOT NULL,
  case_quantity         INTEGER  NOT NULL,                  -- packs per case, LOCKED after save
  case_code             TEXT,                               -- user-defined, unique per product
  rsp_paise             INTEGER,                            -- Recommended Selling Price (RSP)
  mrp_paise             INTEGER,                            -- MRP per case
  case_cost_paise       INTEGER,                            -- purchase cost excl GST
  is_default            INTEGER  NOT NULL DEFAULT 0,        -- one default per product
  created_at            TEXT     NOT NULL,
  updated_at            TEXT     NOT NULL,
  sync_status           TEXT     NOT NULL DEFAULT 'pending'
)

-- Stock levels per location
product_stock (
  id                    INTEGER  PRIMARY KEY AUTOINCREMENT,
  product_guuid         TEXT     NOT NULL REFERENCES products(guuid),
  location_id           INTEGER  NOT NULL REFERENCES locations(id),
  store_id              INTEGER  NOT NULL,
  quantity_on_hand      REAL     NOT NULL DEFAULT 0,        -- REAL for measure-to-sell
  is_available          INTEGER  NOT NULL DEFAULT 1,        -- shown in POS
  is_out_of_stock       INTEGER  NOT NULL DEFAULT 0,        -- manual override
  default_storage_area  TEXT,
  updated_at            TEXT     NOT NULL
)
```

---

## 4. Field specifications — General Information

### 4.1 Product Type

| Attribute | Value |
|-----------|-------|
| Type | Radio button / segmented control |
| Mandatory | Yes |
| Options | Goods / Service |
| Default | From store settings if configured, else none |
| Locked after save | YES — cannot change after product is created |
| Stored as | `product_type TEXT` — 'goods' or 'service' |

**Why locked:** Product type controls inventory treatment, tax category, and which fields are visible. Changing it after creation would silently corrupt stock records and GST calculations on historical transactions.

**Validation:**
```
Required → "Product type is required"
Immutable after save → "Product type cannot be changed after creation"
```

---

### 4.2 Product Name

| Attribute | Value |
|-----------|-------|
| Type | Text input |
| Mandatory | Yes |
| Min length | 3 characters |
| Max length | 100 characters |
| Uniqueness | Per store (case-insensitive) |
| Stored as | `name TEXT` |

**Critical behaviour:** Until a valid name (3+ characters) is entered, **all other fields on the form are disabled**. This is the form gate. It prevents half-complete product records and ensures every product has a meaningful identity before any configuration is set.

**Validation:**
```
Required            → "Product name is required"
< 3 chars           → "Name must be at least 3 characters"
> 100 chars         → "Name cannot exceed 100 characters"
Duplicate in store  → "A product with this name already exists"
Whitespace only     → "Name cannot be blank"
```

---

### 4.3 Description

| Attribute | Value |
|-----------|-------|
| Type | Text area |
| Mandatory | No |
| Max length | 250 characters |
| Stored as | `description TEXT` |

Character counter: shows "X / 250 characters" below the field.

---

### 4.4 Product Image

| Attribute | Value |
|-----------|-------|
| Type | Image picker |
| Mandatory | No |
| Formats | JPG, JPEG, PNG |
| Max size | 1 MB |
| Stored as | `image_uri TEXT` (local path until synced, then CDN URL) |

**Phase 1:** Tap to select from camera roll or take photo. Basic preview.

**Phase 2:** Crop/rotate editor — zoom slider, rotate left/right, drag to reposition.

**Validation:**
```
Wrong format → "Only JPG and PNG images are supported"
> 1 MB       → "Image must be smaller than 1 MB"
```

---

### 4.5 Barcode Toggle

| Attribute | Value |
|-----------|-------|
| Type | Toggle |
| Default | ON for Goods, OFF for Service |
| Locked after save | YES — cannot switch between barcode and pos_code modes |
| Stored as | `is_barcoded INTEGER` |

**When ON:** Barcode field appears. User enters the product's physical barcode (EAN-13, EAN-8, CODE-128, etc.).

**When OFF:** Barcode field hidden. System auto-generates a `pos_code` (e.g., "AYP-001") on save. The POS code is permanent and never reused even if the product is deleted.

---

### 4.6 Barcode

| Attribute | Value |
|-----------|-------|
| Type | Text input |
| Mandatory | No (only visible when Barcode Toggle ON) |
| Min length | 1 character |
| Max length | 15 characters |
| Uniqueness | Per store |
| Locked after save | YES — cannot edit after product is created |
| Stored as | `barcode TEXT` |

**Reuse on deletion:** When a product is deleted, its barcode is released and can be assigned to a new product. A physical barcode label can be repurposed.

**Validation:**
```
> 15 chars         → "Barcode cannot exceed 15 characters"
Duplicate in store → "This barcode is already used by another product"
```

---

### 4.7 POS Code (pos_code)

| Attribute | Value |
|-----------|-------|
| Type | Auto-generated display field |
| Mandatory | N/A — system generates |
| Format | Prefix + sequential number (e.g., AYP-001, AYP-002) |
| Uniqueness | Per store, permanent |
| Editable | Never — always read-only |
| Stored as | `pos_code TEXT` |

Generated on save when Barcode Toggle is OFF. **Never reused** — even if the product is deleted, that code is permanently retired. This maintains audit trail integrity.

---

### 4.8 Product Category

| Attribute | Value |
|-----------|-------|
| Type | Dropdown (hierarchical) |
| Mandatory | Based on store settings |
| Source | `lookups` table, type = PRODUCT_CATEGORY |
| Stored as | `category_lookup_fk INTEGER` |

User can only select leaf nodes (lowest level). Parent categories are display-only.

---

### 4.9 HSN Code

| Attribute | Value |
|-----------|-------|
| Type | Text input |
| Mandatory | Based on store settings |
| Format | 4–8 digits (Indian GST classification) |
| Uniqueness | Per store |
| Stored as | `hsn_code TEXT` |

**Indian GST context:** HSN (Harmonized System of Nomenclature) codes are required on B2B invoices above ₹5 lakh turnover and on all e-way bills. 4-digit HSN is minimum; 8-digit is mandatory for turnover above ₹5 crore.

**Validation:**
```
Invalid format → "HSN code must be 4 to 8 digits"
Duplicate      → "This HSN code is already used by another product"
```

---

### 4.10 Active Toggle

| Attribute | Value |
|-----------|-------|
| Type | Toggle |
| Default | ON (and DISABLED during creation — cannot create an inactive product) |
| Editable | Only in edit mode |
| Stored as | `is_active INTEGER` |

**During creation:** Toggle shows as ON and is greyed out. Every newly created product is active.

**In edit mode:** Toggle becomes interactive. Deactivating a product removes it from the POS grid and all transaction dropdowns. Stock is preserved.

---

### 4.11 Digital Product

| Attribute | Value |
|-----------|-------|
| Type | Toggle |
| Default | OFF |
| Locked after save | YES |
| Stored as | `is_digital INTEGER` |

Used for gift cards, recharge vouchers, digital downloads. Schema ready — UI Phase 2.

---

## 5. Field specifications — Inventory Configuration

> **Store-level gate:** If the store has "Enable Inventory" turned OFF in Settings, this entire section is hidden and all inventory fields are set to OFF. The owner must enable inventory at the store level before any product can be inventory-tracked.

---

### 5.1 Track Inventory

| Attribute | Value |
|-----------|-------|
| Type | Toggle |
| Default | OFF |
| Visibility | Goods only — HIDDEN for Service products |
| Locked when | Product has any active transaction (draft, confirmed, cancelled, voided) |
| Stored as | `track_inventory INTEGER` |

**When ON:**
- Track Quantity auto-enabled and locked ON
- We Buy This Item auto-enabled and locked ON
- Inventory account is required (Phase 2 — for now, sets a flag)
- Stock levels are maintained in `product_stock` table
- Out-of-stock warnings appear in POS grid

**When OFF:**
- Track Quantity can be independently toggled
- We Buy can be independently toggled
- No stock levels maintained

**One-way toggle:** Can be turned ON at any time. Cannot be turned OFF once a transaction exists. The dynamic lock rule: if all transactions referencing this product are deleted, the lock releases.

**UI:** Show a lock icon with tooltip "Inventory tracking is locked because this product is used in active transactions" when locked.

**Validation:**
```
Service product     → Toggle hidden (no validation needed)
Has transactions    → "Cannot change inventory setting while product is in active transactions"
Store inventory OFF → Section hidden
```

---

### 5.2 Track Quantity

| Attribute | Value |
|-----------|-------|
| Type | Toggle |
| Default | OFF |
| Visibility | Goods only — HIDDEN for Service products |
| Auto-enabled | When Track Inventory = ON (and cannot be disabled) |
| Stored as | `track_quantity INTEGER` |

**Use cases:**
- Track Inventory ON + Track Quantity ON → Full inventory (standard retail)
- Track Inventory OFF + Track Quantity ON → Quantity visible, no accounting (drop-ship, made-to-order)
- Track Inventory OFF + Track Quantity OFF → No tracking (one-time items, samples)

---

## 6. Field specifications — Volume and Weight

### 6.1 Measure to Sell

| Attribute | Value |
|-----------|-------|
| Type | Toggle |
| Default | OFF |
| Stored as | `is_measure_to_sell INTEGER` |

**When OFF:** Product sold in whole units (1, 2, 3 bottles). Quantity cannot have decimals.

**When ON:** Product sold in measured quantities. Quantity supports up to 3 decimal places (0.5 kg, 1.75 L). The Volume field becomes mandatory and "Unit" / "Boxes" options are disabled in the Volume dropdown.

**Real-world use cases:**
- Loose rice, dal, sugar sold by kg
- Kerosene or oil sold by litre
- Fabric or wire sold by metre

---

### 6.2 Volume Unit

| Attribute | Value |
|-----------|-------|
| Type | Dropdown |
| Mandatory | Yes when Measure to Sell = ON |
| Options | KG, Gram, Litre, Millilitre, Metre, Centimetre, Unit, Boxes |
| Restriction | Unit and Boxes disabled when Measure to Sell = ON |
| Stored as | `volume_unit TEXT` |

---

### 6.3 Volume Amount

| Attribute | Value |
|-----------|-------|
| Type | Numeric |
| Mandatory | No |
| Max length | 8 characters including decimal |
| Decimal places | Up to 3 |
| Auto-set | Volume Amount = 1 and DISABLED when Volume Unit = "Unit" |
| Stored as | `volume_amount REAL` |

**Validation:**
```
= 0 or negative → "Volume amount must be greater than 0"
```

---

### 6.4 Weight (kg)

| Attribute | Value |
|-----------|-------|
| Type | Numeric |
| Mandatory | No |
| Min value | 0 |
| Stored as | `weight_kg REAL` |

For shipping cost calculations and logistics. Zero is valid (weightless digital products).

---

### 6.5 Pack Size (Pack Value)

| Attribute | Value |
|-----------|-------|
| Type | Integer |
| Default | 1 |
| Min value | 1 |
| Max length | 4 digits |
| Stored as | `pack_size INTEGER` |

Defines the middle tier of the packaging hierarchy:

```
1 Pack  = Pack Size × Units
1 Case  = Case Quantity × Packs
1 Case  = Case Quantity × Pack Size × Units

Example:
  Product:      Coca-Cola 330ml
  Pack Size:    6  (one 6-pack of Coke)
  Case Qty:     4  (one carton = 4 six-packs)
  Result:       1 carton = 4 × 6 = 24 bottles
```

---

## 7. Field specifications — Purchase Configuration

### 7.1 We Buy This Item

| Attribute | Value |
|-----------|-------|
| Type | Toggle |
| Default | From store settings, else OFF |
| Auto-enabled | When Track Inventory = ON (and locked ON) |
| Stored as | `is_we_buy_this_item INTEGER` |

**When ON:** Product appears in purchase flows (future). Purchase Tax Rate field becomes mandatory.

**When OFF → ON:** Previous tax selection is cleared. Store default tax is re-applied.

---

### 7.2 Purchase Tax Rate (GST on Purchase)

| Attribute | Value |
|-----------|-------|
| Type | Dropdown |
| Mandatory | Yes when We Buy = ON |
| Source | `tax_rates` table, filtered by store's GST registration |
| Stored as | `purchase_tax_rate_fk INTEGER` |

**Indian GST rates:** 0%, 5%, 12%, 18%, 28% + special rates (3%, 0.25% for gold/diamonds).

**When We Buy toggled OFF:** Selected rate is cleared, not retained.

**Validation:**
```
We Buy ON + no rate selected → "GST rate is required for purchase"
```

---

## 8. Field specifications — Case Quantity Management

The packaging hierarchy: **Unit → Pack → Case**

Every product must have at least one case quantity. One case must be marked as Default for profit margin calculations.

---

### 8.1 Case Quantity Number

| Attribute | Value |
|-----------|-------|
| Type | Integer |
| Mandatory | Yes (at least one row required) |
| Min value | 1 |
| Max length | 9 digits |
| Uniqueness | Per product (no duplicate quantities for same product) |
| Locked after save | YES — cannot modify existing case quantity |
| Stored as | `product_cases.case_quantity INTEGER` |

**If wrong value entered:** The entire case row must be deleted and recreated. No in-place edit.

**Validation:**
```
Empty              → "Enter a valid case quantity"
= 0                → "Case quantity must be greater than 0"
Decimal            → "Case quantity must be a whole number"
Duplicate for product → "This case quantity already exists for this product"
```

---

### 8.2 Case Code

| Attribute | Value |
|-----------|-------|
| Type | Text input |
| Mandatory | No |
| Max length | 15 characters |
| Uniqueness | Per product (not global) |
| Stored as | `product_cases.case_code TEXT` |

User-defined code for case identification. Same code can be used on different products — uniqueness is enforced only within a single product.

---

### 8.3 RSP / MRP

| Attribute | Value |
|-----------|-------|
| Type | Numeric |
| Mandatory | No |
| Stored as | `product_cases.rsp_paise INTEGER` and `product_cases.mrp_paise INTEGER` |

**RSP (Recommended Selling Price):** Supplier's suggested selling price. Reference only — no enforcement.

**MRP (Maximum Retail Price):** Legal maximum under the Legal Metrology Act (India). The selling price can never exceed MRP. This is enforced at the product level:

```
selling_price ≤ mrp
Error: "Selling price cannot exceed MRP (₹X)"
```

---

### 8.4 Case Cost (excl. GST)

| Attribute | Value |
|-----------|-------|
| Type | Numeric (paise) |
| Mandatory | No |
| Format | Tax-exclusive purchase cost per case |
| Stored as | `product_cases.case_cost_paise INTEGER` |

Negative values auto-converted to positive.

---

### 8.5 Unit Cost (incl. GST) — calculated

Auto-calculated, read-only.

```
Step 1: Case cost including GST
        = case_cost_paise × (1 + purchase_gst_rate / 100)

Step 2: Cost per pack (incl GST)
        = case_cost_incl / case_quantity

Step 3: Cost per unit (incl GST)
        = cost_per_pack / pack_size

Display: unit_cost_incl_paise / 100 formatted in en-IN locale
```

Recalculates when: case cost, purchase GST rate, case quantity, or pack size changes.

---

### 8.6 Default Case

| Attribute | Value |
|-----------|-------|
| Type | Toggle / radio (only one ON at a time) |
| Mandatory | At least one case must be marked default |
| Stored as | `product_cases.is_default INTEGER` |

**Rules:**
- Exactly one case must be default at all times
- When a new case is marked default, the previous default auto-clears
- Cannot unmark the only default (system blocks it)
- When the default case is deleted, the system auto-marks the next case in the list as default
- Profit margin always calculated using the default case's cost

---

## 9. Field specifications — Sales Configuration

### 9.1 We Sell This Item

| Attribute | Value |
|-----------|-------|
| Type | Toggle |
| Default | From store settings, else ON |
| Stored as | `is_we_sell_this_item INTEGER` |

**When ON:** Product appears in POS grid and transaction dropdowns. Sales Tax Rate becomes mandatory.

**When OFF → ON:** Previous tax selection cleared. Store default re-applied.

A product can have both We Buy OFF and We Sell OFF simultaneously (internal items, future products, templates).

---

### 9.2 Sales Tax Rate (GST on Sales)

| Attribute | Value |
|-----------|-------|
| Type | Dropdown |
| Mandatory | Yes when We Sell = ON |
| Source | `tax_rates` table, filtered by store's GST registration |
| Stored as | `sales_tax_rate_fk INTEGER` |

**Two-tier inheritance (applied when We Sell is toggled ON):**
1. If Purchase Tax Rate is already selected → Sales Tax Rate inherits that same rate
2. If Purchase Tax Rate is empty → Sales Tax Rate uses store's default sales GST from settings
3. If both empty → User must select manually

**Why:** In Indian retail, the GST rate on purchases and sales of the same product is always the same (you cannot buy Coke at 18% GST and sell it at 12% GST). Auto-inheriting the purchase rate saves data entry in 99% of cases.

**Validation:**
```
We Sell ON + no rate → "GST rate is required for sales"
```

---

## 10. Field specifications — Selling Price and Profit Margin

### 10.1 Selling Price

| Attribute | Value |
|-----------|-------|
| Type | Numeric (stored as paise) |
| Mandatory | Yes when We Sell = ON |
| Tax treatment | Inclusive (price shown to customer includes GST) |
| Stored as | `selling_price_paise INTEGER` (current), `product_price_history` (history) |

**Indian retail convention:** All prices displayed and entered as tax-inclusive (MRP includes GST). The underlying calculation extracts the tax component.

**MRP enforcement:**
```
selling_price_paise ≤ mrp_paise
Error: "Selling price ₹X exceeds MRP ₹Y"
```

---

### 10.2 Selling Price Inclusive Toggle

| Attribute | Value |
|-----------|-------|
| Type | Toggle |
| Default | ON (price includes GST) |
| Stored as | `selling_price_inclusive INTEGER` |

**Critical:** This flag must be set correctly for the profit margin calculation to be accurate. All Indian retail prices are tax-inclusive (this is the MRP convention). The flag exists for the rare case where the owner enters a tax-exclusive base price.

---

### 10.3 Effective Date Pricing (price history)

Every price change is stored in `product_price_history` with an `effective_from` datetime.

```
Price history rows:
  ₹45  effective from 2025-01-01 00:00  ← original price
  ₹50  effective from 2025-06-01 00:00  ← price increase
  ₹48  effective from 2025-08-01 00:00  ← promotional drop

Price at any moment = the most recent row where effective_from ≤ transaction_datetime
```

**Phase 1 UI:** Show only the current effective price on the product form. Price history visible as a "View price history" link.

**Phase 2 UI:** Full price chip UI showing all historical and future-dated prices.

**Duplicate effective datetime rule:** Same `effective_from` cannot be used twice for the same product. First entry wins. Later duplicate is rejected.

---

### 10.4 Profit Margin Amount — calculation

Auto-calculated, read-only. Displayed on the product card in the Products list and on the product detail screen.

```
Given:
  selling_price_paise    = 12000  (₹120, tax-inclusive)
  selling_price_inclusive = 1      (price includes GST)
  sales_gst_rate         = 18%
  case_cost_paise        = 80000  (₹800 per case, tax-exclusive)
  case_quantity          = 10     (default case)
  pack_size              = 6

Step 1: Tax-exclusive selling price
  if selling_price_inclusive:
    excl_price = selling_price_paise / (1 + sales_gst_rate / 100)
    excl_price = 12000 / 1.18 = 10169 paise (₹101.69)
  else:
    excl_price = selling_price_paise

Step 2: Per-unit cost (tax-exclusive)
  cost_per_unit = case_cost_paise / case_quantity / pack_size
  cost_per_unit = 80000 / 10 / 6 = 1333 paise (₹13.33)

Step 3: Profit margin amount
  margin_paise = excl_price - cost_per_unit
  margin_paise = 10169 - 1333 = 8836 paise (₹88.36)

Display: ₹88.36
```

Negative margins are displayed (selling at a loss is a valid business scenario — clearance, loss leader).

---

### 10.5 Profit Margin Percentage — calculation

```
Step 4: Profit margin percentage
  margin_pct = (margin_paise / excl_price) × 100
  margin_pct = (8836 / 10169) × 100 = 86.89%

Display: 86.89%
```

---

### 10.6 Recalculation triggers

Profit margin recalculates whenever any of these change:
- Selling price
- Selling price inclusive flag
- Sales GST rate
- Case cost (default case)
- Case quantity (default case)
- Pack size
- Purchase GST rate (affects unit cost)
- Which case is marked as default

---

## 11. Field specifications — Location and Storage

### 11.1 Available (per location)

| Attribute | Value |
|-----------|-------|
| Type | Toggle per location row |
| Default | ON for all active locations during creation |
| Stored as | `product_stock.is_available INTEGER` |

**Auto-enable for new locations:** When the owner adds a new store location after products are already created, all existing products automatically get `is_available = 1` for the new location. No manual setup required.

**Cannot be ON when Out of Stock is ON.** These two states are mutually exclusive.

---

### 11.2 Out of Stock (per location)

| Attribute | Value |
|-----------|-------|
| Type | Toggle per location row |
| Default | OFF |
| Stored as | `product_stock.is_out_of_stock INTEGER` |

**When set to ON:**
- `is_available` automatically set to OFF
- Product disappears from POS grid for that location
- Stock quantity is preserved (this is a manual status flag, not a stock depletion)
- Cashier cannot add this product to the cart

**Use case:** Supplier is out of stock, product is temporarily unavailable for selling.

---

### 11.3 Default Storage Area

| Attribute | Value |
|-----------|-------|
| Type | Dropdown per location |
| Mandatory | No |
| Source | Storage areas configured for each location |
| Stored as | `product_stock.default_storage_area TEXT` |

---

## 12. Field specifications — Notes and Attachments

### 12.1 Notes

| Attribute | Value |
|-----------|-------|
| Type | Text area |
| Mandatory | No |
| Max length | 250 characters |
| Stored as | `products.notes TEXT` |

Internal notes not visible to customers. Examples: storage instructions, supplier notes, reorder reminders.

---

### 12.2 Attachments

| Attribute | Value |
|-----------|-------|
| Type | File picker (multiple) |
| Mandatory | No |
| Max files | 10 per product |
| Max size | 1 MB per file |
| Formats | PDF, JPG, JPEG, PNG, DOC, DOCX |

Stored as local URIs until synced. Examples: product specification sheets, certificates, images of the product in storage.

**Phase 1:** Basic file attach and view.
**Phase 2:** Preview within the app, share via share sheet.

---

## 13. Form behaviour — how fields interact

### 13.1 The form gate

```
Name.length < 3 → ALL other fields are disabled
Name.length >= 3 → All fields enable based on their own rules
```

This is the single most important form rule. It prevents saving products with only a partial configuration.

---

### 13.2 Product Type drives form structure

```
Product Type = Goods
  → Barcode toggle: default ON
  → Inventory section: VISIBLE
  → MRP field: VISIBLE

Product Type = Service
  → Barcode toggle: default OFF
  → Inventory section: HIDDEN (Track Inventory, Track Quantity both hidden)
  → MRP field: HIDDEN
```

---

### 13.3 Track Inventory drives We Buy and account filtering

```
Track Inventory = ON
  → We Buy: auto-enabled and LOCKED (cannot disable)
  → Track Quantity: auto-enabled and LOCKED

Track Inventory = OFF
  → We Buy: user-controlled
  → Track Quantity: user-controlled
```

---

### 13.4 We Buy drives purchase tax

```
We Buy = toggled ON
  → Purchase Tax Rate field appears
  → Auto-populate from store default GST setting

We Buy = toggled OFF
  → Purchase Tax Rate field hides
  → Selected rate CLEARED (not retained)

We Buy = OFF then ON again
  → Store default re-applied (previous manual selection is lost)
  → This is intentional — toggling OFF is treated as a reset
```

---

### 13.5 Sales Tax inherits from Purchase Tax

```
We Sell = toggled ON
  → Income Tax Rate field appears
  → Auto-populate priority:
      1st: Purchase Tax Rate (if already selected)
      2nd: Store default Sales GST (if Purchase Tax empty)
      3rd: Empty (user must select)

Example:
  Owner sets Purchase Tax = 18%
  Owner toggles We Sell ON
  Sales Tax auto-fills to 18% ← inherits from Purchase Tax
```

---

### 13.6 Measure to Sell drives volume options

```
Measure to Sell = ON
  → Volume unit becomes mandatory
  → "Unit" and "Boxes" options disabled in Volume dropdown
  → Quantity supports decimals (up to 3 places) throughout the app

Measure to Sell = OFF
  → All volume units available
  → Quantity is whole numbers only
```

---

### 13.7 Out of Stock auto-clears Available

```
Out of Stock = toggled ON at location X
  → Available at location X automatically = OFF
  → Product disappears from POS grid at location X

Out of Stock = toggled OFF at location X
  → Available at location X remains OFF (must manually re-enable)
  → Available is not auto-restored
```

---

### 13.8 Store Settings defaults (equivalent of Book Settings)

When the product form opens, these fields auto-populate from Store Settings:

| Field | Auto-populated from |
|-------|---------------------|
| Product Category | Store default category (if set) |
| We Buy default | Store setting |
| We Sell default | Store setting |
| Purchase GST Rate | Store default purchase GST |
| Sales GST Rate | Inherited from Purchase GST |

**Mid-session changes:** If the store admin changes these defaults while the product form is open, the current form is NOT affected. Only new form opens will use the new defaults. This prevents mid-session data confusion.

---

## 14. Product create flow

```
User taps "+" in Products header
    ↓
ProductCreateScreen opens as modal (no tab bar)
app/(store)/product-create.tsx → features/products/screens/ProductCreateScreen.tsx
    ↓
Step 1: Select Product Type (Goods or Service)
        Form fields all disabled at this point
    ↓
Step 2: Enter Product Name (3+ characters)
        Form fields enable as name becomes valid
    ↓
Step 3: Configure fields per product type
        (Inventory, Volume, Purchase, Case, Sales, Price, Location, Notes)
    ↓
Step 4: Tap "Save"
    ↓
Validation runs:
  - Required fields check
  - MRP ≥ selling price check
  - GST rate selected if We Sell ON
  - Case quantity present
  - Barcode uniqueness (checked against local SQLite first)
    ↓
If validation fails → inline errors shown, save blocked
    ↓
If validation passes:
  - Product written to local SQLite (sync_status = 'pending')
  - pos_code generated if is_barcoded = 0
  - router.dismiss() → modal closes
  - Products list re-fetches from SQLite
  - Success toast shown: "Product created"
    ↓
Sync engine picks up pending record and pushes to server
```

---

### 14.1 Create from the More → Customers → Product path

Same flow. `product-create.tsx` accepts an optional `barcode` param:

```typescript
router.push({
  pathname: '/(store)/product-create',
  params: { barcode: scannedBarcode },
});
```

When `barcode` param is present, the form pre-fills the barcode field and sets `is_barcoded = 1`.

---

### 14.2 Unsaved changes guard

If the form is dirty (any field changed) and the user attempts to leave:

- iOS: swipe-to-dismiss gesture is blocked (`gestureEnabled: false` on the modal or dynamic via `useUnsavedChangesGuard`)
- Android: hardware back button triggers confirmation alert
- Both: Alert asks "Discard changes?" with Cancel / Discard options

---

## 15. Product edit flow

```
User taps Edit on a product (from product detail or swipe action)
    ↓
ProductEditScreen opens as modal (no tab bar)
app/(store)/product-edit.tsx → features/products/screens/ProductEditScreen.tsx
    ↓
Form pre-populated with current product values
    ↓
Locked fields (read-only, visually greyed):
  - Product Type
  - Digital Product
  - Barcode (if is_barcoded = 1)
  - POS Code (always read-only)
  - Case Quantity Number (per existing case rows)
    ↓
Editable fields:
  - All others per their editability rules
  - Active toggle now editable (was disabled during creation)
  - New case quantity rows can be added
  - Existing case rows: cost, code, RSP, default can be edited; quantity is locked
    ↓
Track Inventory lock check:
  If product has active transactions → Track Inventory shows lock icon, tooltip shown
  If no transactions → Track Inventory freely toggleable
    ↓
User taps "Save"
    ↓
Same validation as create, plus:
  - MRP cannot be lowered below any active selling price
    ↓
Local SQLite updated (sync_status = 'pending')
router.dismiss()
Success toast: "Product updated"
```

---

## 16. Product delete flow

### 16.1 Delete checks (in order — all must pass)

```
Check 1: Does the product have active transactions?
  → ANY transaction (sale, purchase, stock adjustment, cancelled, voided)
  → Error: "Cannot delete. This product has been used in X transaction(s)"

Check 2: Does the product have stock on hand > 0?
  → Any location with quantity_on_hand > 0
  → Error: "Cannot delete. Product has X units in stock"

Check 3: Is it the only product in an active promotion?
  → (Phase 2 check)

If all checks pass:
  → Confirmation alert: "Delete [Product Name]? This cannot be undone."
  → User confirms
  → Soft delete: products.deleted_at = NOW()
  → If is_barcoded = 1: barcode is released (can be reused)
  → If is_barcoded = 0: pos_code is permanently retired (never reused)
  → Sync engine sends delete to server
  → Product disappears from all lists and POS grid
```

---

### 16.2 Deactivate vs Delete

| Action | Stock | Transactions | Reversible | POS grid |
|--------|-------|-------------|------------|----------|
| Deactivate | Preserved | Preserved | Yes (re-activate) | Removed |
| Delete | Lost (if force-deleted) | Blocks delete if any exist | No | Removed |

**Recommendation for owners:** Deactivate products that are no longer sold but have history. Delete only products created by mistake with no transactions.

---

## 17. Product clone flow

```
User taps "Clone" on a product (from kebab menu in product list)
    ↓
System copies all fields EXCEPT:
  - Name (new product needs a unique name)
  - POS Code (new code auto-generated)
  - Case Plof Codes (new codes generated per case)
  - Barcode (if is_barcoded = 1 — must provide a new unique barcode)
    ↓
ProductCreateScreen opens with pre-filled values
Title field shows "[Original Name] (Copy)" — user must edit before saving
    ↓
Validation runs same rules as create:
  - Name must be unique
  - If barcoded: new barcode must be different from original and unique in store
    ↓
Clone saves as new product with sync_status = 'pending'
    ↓
Cloned product starts with ZERO active transactions
Track Inventory is editable until first transaction
```

**Account validation at clone time:** If the source product references a tax rate that no longer exists (deleted from store settings), the clone form shows an error on that field: "Tax rate no longer exists — please select a valid rate."

---

## 18. Barcode scanner → product create flow

```
Cashier scans a barcode in the POS scanner screen
    ↓
Scanner looks up barcode in local SQLite:
  products.find(p => p.barcode === data && p.is_active === 1)
  ??
  products.find(p => p.case_barcode === data && p.is_active === 1)
    ↓
If product FOUND → add to cart (normal POS flow)
    ↓
If product NOT FOUND:
  → Error toast: "No product found for this barcode"
  → "Create product?" action button in toast
  → Tapping it navigates:
      router.replace('/(store)/product-create?barcode=encodedValue')
  → Product create modal opens with barcode pre-filled
  → Owner creates the product
  → On save, returns to POS scanner
```

---

## 19. Products list screen

### 19.1 Screen structure

```
Route: app/(store)/(main)/(tabs)/products/index.tsx
Feature: features/products/screens/ProductsScreen.tsx
Tab bar: VISIBLE (this is the tab root)
```

### 19.2 Header

- Title: "Products"
- Right: "+" add button (requires Product.create permission)
- Right: Filter icon (opens filter bottom sheet)

### 19.3 Search bar

- Searches: product name, barcode, pos_code, HSN code
- Debounced 200ms
- Minimum 2 characters

### 19.4 Stock filter chips

```
All        — all active products
In stock   — quantity_on_hand > 0
Low stock  — quantity_on_hand > 0 but below reorder threshold
Out of stock — quantity_on_hand = 0 or is_out_of_stock = 1
```

Chip colours: In stock = green, Low stock = amber, Out of stock = red.

### 19.5 Product count row

Shows: "X products · sorted A–Z"

### 19.6 Product list row

Each row shows:
- Avatar (first 2 letters of product name, distinct colour per product)
- Product name
- SKU (pos_code or barcode)
- Unit price (selling_price_paise formatted as ₹X in en-IN locale)
- Stock badge (X in stock / X low stock / Out of stock)
- Chevron → navigates to product detail

### 19.7 Swipe actions

Using `SwipeableRow` from `src/shared/components/SwipeableRow/`:

```
Swipe left reveals:
  [Edit — blue]    → opens ProductEditScreen modal
  [Delete — red]   → triggers delete flow with checks
```

When cashier role (no edit/delete permission) → swipe is disabled.

### 19.8 Product detail screen

```
Route: app/(store)/(main)/(tabs)/products/[guuid]/index.tsx
Feature: features/products/screens/ProductDetailScreen.tsx
Tab bar: HIDDEN (Stack child)
```

Shows: all product fields, price history, stock per location.
Header right: Edit button (requires Product.edit permission), Delete button (requires Product.delete permission).

---

## 20. RBAC — role-based access control

### 20.1 Permission matrix

| Action | Owner | Manager | Cashier |
|--------|-------|---------|---------|
| View product list | ✅ | ✅ | ✅ |
| View product detail | ✅ | ✅ | ✅ |
| Create product | ✅ | ✅ | ❌ |
| Edit product | ✅ | ✅ | ❌ |
| Delete product | ✅ | ❌ | ❌ |
| Clone product | ✅ | ✅ | ❌ |
| Edit selling price | ✅ | ✅ (if permitted) | ❌ |
| View profit margin | ✅ | ✅ | ❌ |
| Change track inventory | ✅ | ❌ | ❌ |

### 20.2 Enforcement layers

**Layer 1 — Tab visibility**

Products tab: `href: canViewProducts ? undefined : null`

If a cashier has no `Product.view` permission, the Products tab is completely removed from the tab bar.

**Layer 2 — Layout RBAC guard**

```typescript
// app/(store)/(main)/(tabs)/products/_layout.tsx
const canView = useRouteGuard('Product', 'view');
if (!canView) return <Redirect href="/(store)" />;
```

Blocks deep-link access for roles without view permission.

**Layer 3 — Screen-level UI**

- No "+" button shown if no create permission
- No edit icon on product detail if no edit permission
- Swipe actions hidden if no edit/delete permission
- Profit margin hidden for cashier role

---

## 21. Offline-first behaviour

### 21.1 What works offline

| Operation | Offline behaviour |
|-----------|------------------|
| View product list | ✅ Reads from local SQLite |
| Search products | ✅ Reads from local SQLite |
| Create product | ✅ Saved locally, queued for sync |
| Edit product | ✅ Saved locally, queued for sync |
| Delete product | ✅ Soft-deleted locally, queued for sync |
| POS scan lookup | ✅ All lookups against local SQLite |
| Stock level display | ✅ From local SQLite |
| Profit margin | ✅ Calculated from local data |

### 21.2 What requires connectivity

| Operation | Online behaviour |
|-----------|-----------------|
| Sync new product to server | Queued — sends when online |
| Download product images from CDN | Cached locally after first load |
| Verify barcode uniqueness across all devices | Checked server-side at sync |

### 21.3 Conflict resolution

If two devices create a product with the same name simultaneously while offline:

```
Device A (offline): creates "Amul Butter 500g" → local guuid A1
Device B (offline): creates "Amul Butter 500g" → local guuid B1

Both sync to server:
  A1 arrives first → accepted
  B1 arrives second → server rejects (name duplicate)
  
Device B receives rejection:
  → Product B1 marked with sync_status = 'conflict'
  → User sees "Conflict: rename this product" in sync issues screen
  → Owner renames, re-syncs
```

---

## 22. Sync behaviour

Products participate in the standard sync engine.

### 22.1 Sync triggers

- App foreground → sync runs
- Product created/edited/deleted → `syncOrchestrator.trigger()` called immediately
- Every 5 minutes while app is open
- Manual pull-to-refresh on Products list

### 22.2 Sync payload

Product sync uses `product.sync.ts` entity applier:

```typescript
// Outgoing (local → server)
toSyncShape(product: ProductRow): ProductSyncPayload {
  return {
    guuid:                  product.guuid,
    name:                   product.name,
    product_type:           product.product_type,
    is_barcoded:            product.is_barcoded,
    barcode:                product.barcode,
    pos_code:               product.pos_code,
    hsn_code:               product.hsn_code,
    track_inventory:        product.track_inventory,
    track_quantity:         product.track_quantity,
    is_measure_to_sell:     product.is_measure_to_sell,
    volume_unit:            product.volume_unit,
    volume_amount:          product.volume_amount,
    weight_kg:              product.weight_kg,
    pack_size:              product.pack_size,
    is_we_buy_this_item:    product.is_we_buy_this_item,
    purchase_tax_rate_fk:   product.purchase_tax_rate_fk,
    is_we_sell_this_item:   product.is_we_sell_this_item,
    sales_tax_rate_fk:      product.sales_tax_rate_fk,
    selling_price_paise:    product.selling_price_paise,
    selling_price_inclusive: product.selling_price_inclusive,
    mrp_paise:              product.mrp_paise,
    is_active:              product.is_active,
    category_lookup_fk:     product.category_lookup_fk,
    notes:                  product.notes,
    deleted_at:             product.deleted_at,
  };
}
```

### 22.3 Critical sync fixes required

From the pending items list tracked across this conversation:

```
1. toSyncShape() must include all 7 new fields:
   is_we_sell_this_item, is_we_buy_this_item,
   is_measure_to_sell, pack_size, case_barcode,
   selling_price_inclusive, mrp_paise

2. tracking_type enum (not boolean flags):
   Backend expects tracking_type: 'none' | 'quantity' | 'inventory'
   Not: track_inventory: bool + track_quantity: bool
   Map: none → both OFF, quantity → quantity ON only, inventory → both ON

3. category_lookup_fk must send null not 0:
   Backend rejects positive() check when fk = 0
   Fix: category_lookup_fk: product.category_lookup_fk ?? null
```

---

## 23. Business rules — complete list

### General

| Rule | Description |
|------|-------------|
| BR-P-001 | Product name is mandatory, 3–100 characters, unique per store (case-insensitive) |
| BR-P-002 | All form fields disabled until name has 3+ valid characters |
| BR-P-003 | Product type is locked after creation — cannot be changed |
| BR-P-004 | Digital product flag is locked after creation — cannot be changed |
| BR-P-005 | Active toggle is ON and disabled during creation — only editable in edit mode |
| BR-P-006 | Barcode toggle is locked after creation — cannot switch between barcode and pos_code modes |
| BR-P-007 | Barcode is locked after creation — cannot be edited |
| BR-P-008 | Deleted product's barcode is released for reuse |
| BR-P-009 | pos_code is permanently reserved after assignment — never reused even after deletion |
| BR-P-010 | MRP must be ≥ selling price at all times |
| BR-P-011 | Selling price is tax-inclusive by default (Indian retail convention) |

### Inventory

| Rule | Description |
|------|-------------|
| BR-INV-001 | Track Inventory and Track Quantity are hidden for Service products |
| BR-INV-002 | Track Inventory can only be enabled when store has "Enable Inventory" turned ON |
| BR-INV-003 | Track Inventory ON → Track Quantity auto-enabled and locked |
| BR-INV-004 | Track Inventory ON → We Buy auto-enabled and locked |
| BR-INV-005 | Track Inventory is locked when product has any active transaction |
| BR-INV-006 | Active transactions include: all statuses (draft, confirmed, cancelled, voided) |
| BR-INV-007 | Dynamic lock: if all transactions deleted, Track Inventory becomes editable again |
| BR-INV-008 | "Enable Inventory" at store level defaults to OFF — must be explicitly enabled |
| BR-INV-009 | Once "Enable Inventory" is turned ON at store level, it cannot be turned OFF |

### Tax and pricing

| Rule | Description |
|------|-------------|
| BR-TAX-001 | Purchase GST rate is mandatory when We Buy = ON |
| BR-TAX-002 | Sales GST rate is mandatory when We Sell = ON |
| BR-TAX-003 | Sales GST inherits from Purchase GST when We Sell is toggled ON |
| BR-TAX-004 | Sales GST fallback: store default → manual selection |
| BR-TAX-005 | When We Buy or We Sell is toggled OFF, the selected tax rate is cleared |
| BR-TAX-006 | Toggling We Buy or We Sell OFF then ON re-applies store defaults (manual selection lost) |
| BR-PRICE-001 | Profit margin uses default case cost — always and only |
| BR-PRICE-002 | Profit margin calculation strips tax from selling price before computing margin |
| BR-PRICE-003 | Negative profit margins are displayed (not blocked) |
| BR-PRICE-004 | Effective date pricing: transaction uses the most recent price with effective_from ≤ transaction datetime |
| BR-PRICE-005 | Duplicate effective_from for same product is rejected — first entry wins |

### Case quantities

| Rule | Description |
|------|-------------|
| BR-CQ-001 | At least one case quantity row is required per product |
| BR-CQ-002 | Case quantity must be a positive integer |
| BR-CQ-003 | Case quantity is unique per product (no duplicates within same product) |
| BR-CQ-004 | Case quantity number is locked after save — cannot be edited |
| BR-CQ-005 | Exactly one case must be marked as default at all times |
| BR-CQ-006 | Marking a new case as default auto-clears the previous default |
| BR-CQ-007 | Cannot unmark the only default case (system blocks it) |
| BR-CQ-008 | When default case is deleted, next case in list is auto-marked as default |
| BR-CQ-009 | Case code is unique per product (not global) |
| BR-CQ-010 | RSP and selling price are independent — no enforcement relationship |
| BR-CQ-011 | MRP per case ≥ selling price per unit × units-per-case |

### Locations

| Rule | Description |
|------|-------------|
| BR-LOC-001 | Product is enabled for all active locations during creation |
| BR-LOC-002 | New location added to store → all existing products auto-enabled at that location |
| BR-LOC-003 | Out of Stock ON → Available automatically OFF |
| BR-LOC-004 | Cannot set Available ON while Out of Stock is ON |
| BR-LOC-005 | Out of Stock OFF does not auto-restore Available — must be manually re-enabled |

### Lifecycle

| Rule | Description |
|------|-------------|
| BR-LIFE-001 | Cannot delete a product that has any transaction history |
| BR-LIFE-002 | Cannot delete a product with stock on hand > 0 |
| BR-LIFE-003 | Deactivating a product does not clear stock |
| BR-LIFE-004 | Deleted products are soft-deleted (deleted_at timestamp) |
| BR-LIFE-005 | Hard delete after 7 years (GST audit requirement under Indian Companies Act) |

---

## 24. Validation matrix

| Field | Rule | Error message |
|-------|------|---------------|
| Name | Required | "Product name is required" |
| Name | < 3 chars | "Name must be at least 3 characters" |
| Name | > 100 chars | "Name cannot exceed 100 characters" |
| Name | Duplicate in store | "A product with this name already exists" |
| Name | Whitespace only | "Name cannot be blank" |
| Barcode | > 15 chars | "Barcode cannot exceed 15 characters" |
| Barcode | Duplicate in store | "This barcode is already used by another product" |
| HSN Code | Not 4–8 digits | "HSN code must be 4 to 8 digits" |
| Image | Wrong format | "Only JPG and PNG images are supported" |
| Image | > 1 MB | "Image must be smaller than 1 MB" |
| Selling Price | > MRP | "Selling price ₹X exceeds MRP ₹Y" |
| Selling Price | Negative | "Selling price cannot be negative" |
| MRP | Negative | "MRP cannot be negative" |
| Volume Amount | ≤ 0 | "Volume amount must be greater than 0" |
| Pack Size | < 1 | "Pack size must be at least 1" |
| Pack Size | Decimal | "Pack size must be a whole number" |
| Case Quantity | Empty | "Enter a valid case quantity" |
| Case Quantity | ≤ 0 | "Case quantity must be greater than 0" |
| Case Quantity | Decimal | "Case quantity must be a whole number" |
| Case Quantity | Duplicate | "This case quantity already exists for this product" |
| Case Code | Duplicate for same product | "This case code already exists for this product" |
| Purchase GST | Empty when We Buy ON | "GST rate is required for purchase" |
| Sales GST | Empty when We Sell ON | "GST rate is required for sales" |
| Track Inventory | Has transactions | "Cannot change inventory setting while product is in active transactions" |
| No default case | Save attempted | "At least one case quantity must be marked as default" |
| No case row | Save attempted | "At least one case quantity is required" |

---

## 25. Real-world scenarios

### Scenario 1 — Kirana owner adds Amul Butter 500g

```
1. Owner taps "+" in Products tab
2. Selects product type: Goods
3. Enters name: "Amul Butter 500g"  → form enables
4. Barcode toggle: ON
5. Enters barcode: "8901063024444" (Amul Butter EAN-13)
6. HSN code: "04052090" (butter under Indian GST)
7. Category: Dairy
8. We Buy: ON → Purchase GST auto-fills 12% (from store default)
9. We Sell: ON → Sales GST auto-inherits 12% from purchase GST
10. Selling price: ₹260 (inclusive)
11. MRP: ₹275 (printed on pack)
12. Case quantity: 12 (one carton = 12 units)
13. Pack size: 1 (no intermediate pack)
14. Case cost: ₹2,400 (₹200 per unit)
15. Profit margin auto-calculates:
    Tax-excl sell price = 260 / 1.12 = ₹232.14
    Unit cost (excl GST) = 2400 / 12 / 1 = ₹200
    Margin = ₹232.14 - ₹200 = ₹32.14 (13.85%)
16. Track Inventory: ON → We Buy locks ON, Track Quantity locks ON
17. Save → product created, appears in POS grid
```

---

### Scenario 2 — Cashier scans unknown barcode

```
Cashier scans "8901063099999" (new product not in system)
    ↓
No match found in local SQLite
    ↓
Error toast: "No product found for this barcode"
Action button: "Create product"
    ↓
Cashier taps "Create product" (if they have Product.create permission)
    ↓
Product create modal opens with barcode "8901063099999" pre-filled
    ↓
Owner fills in name, GST rate, price
Saves
    ↓
Returns to scanner
Product is now in SQLite
Next scan of the same barcode succeeds
```

---

### Scenario 3 — Owner changes price of rice for Diwali sale

```
Current price: ₹450 (effective from Jan 1)
New sale price: ₹420 (effective from Oct 1 to Oct 31)
Return to normal: ₹450 (effective from Nov 1)

Owner opens product edit for "Basmati Rice 5kg"
Taps "Price history"
Adds price entry:
  ₹420, effective from 2025-10-01 00:00
Adds price entry:
  ₹450, effective from 2025-11-01 00:00
Saves

From Oct 1 to Oct 31: POS uses ₹420
From Nov 1 onwards: POS uses ₹450 (reverts)
No manual change needed on Nov 1
```

---

### Scenario 4 — Owner swipes to delete a product

```
Owner swipes left on "Expired Stock Item" in Products list
Delete (red) button reveals
Owner taps Delete
    ↓
System checks:
  Check 1: Any transactions? → 0 transactions ✅
  Check 2: Stock on hand?   → 5 units ❌
    ↓
Error: "Cannot delete. Product has 5 units in stock.
        Adjust stock to zero first, then delete."
    ↓
Owner goes to stock adjustment (Phase 2)
Reduces stock to 0
Returns to Products
Swipes to delete
Check 2 now passes → Confirmation shown → Deleted
```

---

### Scenario 5 — Manager tries to delete a product

```
Role: Manager (has Product.edit, no Product.delete)

Manager opens Products list
Swipe action only shows [Edit] — Delete action is hidden
Manager cannot delete any product
```

---

### Scenario 6 — Store opens second location

```
Owner adds "Branch 2" as a new location in Settings
    ↓
System trigger runs:
  INSERT INTO product_stock (product_guuid, location_id, is_available, quantity_on_hand)
  SELECT guuid, [branch_2_location_id], 1, 0
  FROM products
  WHERE is_active = 1 AND store_id = [store_id]
    ↓
All 150 existing products are now automatically
enabled at Branch 2 with Available = ON and stock = 0
    ↓
Owner does not need to manually enable each product
Stock takes can begin immediately
```

---

### Scenario 7 — Loose rice sold by weight (Measure to Sell)

```
Owner creates "Basmati Rice Loose" (Goods)
Measure to Sell: ON
Volume unit: KG
Volume amount: 1
Selling price: ₹90 per kg
GST: 5% (food grain under Indian GST)

In POS:
Cashier selects "Basmati Rice Loose"
Quantity input supports decimals: 0.5, 1.5, 2.25 kg
Cart shows: Basmati Rice Loose × 1.5 kg = ₹135
```

---

### Scenario 8 — Product price exceeds MRP

```
Owner edits Amul Butter 500g
Tries to change selling price from ₹260 to ₹280
MRP on product is ₹275

Validation fires:
"Selling price ₹280 exceeds MRP ₹275.
 Under the Legal Metrology Act, products cannot be sold above printed MRP."

Save is blocked
Owner must either:
  a) Keep selling price ≤ ₹275
  b) Update MRP to the new pack's printed MRP and then set selling price
```

---

## 26. Dos and don'ts

### Dos

**Always read `selling_price_inclusive` before calculating profit margin.** Tax-inclusive and tax-exclusive prices produce very different margins. The flag exists for a reason — check it every time.

**Use `pos_code` as the stable internal identifier, not `id`.** The auto-increment integer `id` is local to each device. `pos_code` or `guuid` is the stable cross-device identifier for a product.

**Derive avatar colours from the product name or guuid deterministically.** Two products starting with "B" (Basmati Rice and Blue Star Pen) must not get the same colour. Use a hash of the guuid to pick from the colour palette.

**Store all money values as paise (integer).** `selling_price_paise = 26000` not `selling_price = 260.00`. Floating-point arithmetic on currency causes rounding errors. Integer paise arithmetic is exact.

**Format INR using `en-IN` locale.** `(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 })` produces "₹1,00,000" (Indian comma grouping) not "₹100,000" (Western grouping).

**Check `is_active === 1` AND `is_we_sell_this_item === 1` before showing in POS grid.** A product can be active but not sellable (e.g., raw material only used for production).

**Lock barcode, product type, and case quantity after save.** These three fields affect historical transaction data. Any change post-creation corrupts audit trails.

**Show profit margin only to roles with permission.** Margin is sensitive business information. Cashiers should not see it.

### Don'ts

**Never show a product as "In Stock" based on `is_available = 1` alone.** Also check `is_out_of_stock = 0` and, if Track Quantity is ON, that `quantity_on_hand > 0`.

**Never allow selling price > MRP.** The Legal Metrology (Packaged Commodities) Rules 2011 prohibit selling packaged goods above MRP in India. This is a legal violation, not just a business rule.

**Never let `category_lookup_fk` be 0.** The backend validates this as a positive integer foreign key. Use `null` when no category is selected, not `0`.

**Never send `track_inventory: bool` to the backend.** The backend expects `tracking_type: 'none' | 'quantity' | 'inventory'`. Map before sending.

**Never remove a product from the POS grid by deleting the record.** Use deactivation (`is_active = 0`) or out-of-stock status (`is_out_of_stock = 1`). Deletion is irreversible and blocked if any transactions exist.

**Never skip the unsaved-changes guard on the product form.** The product form has 20+ fields. An accidental back gesture discards significant data entry. `useUnsavedChangesGuard` must be active whenever the form is dirty.

**Never calculate profit margin without extracting the tax first.** `margin = selling_price - cost` is wrong for tax-inclusive prices. Always divide selling price by `(1 + gst_rate / 100)` first.

**Never use `gap` CSS property on Android below RN 0.71.** Use directional `margin-left` and `margin-right` on child elements instead. This applies to all product form rows and list items.

---

*Document version: 1.0 — Ayphen Retail Mobile — Products & Services*
*Based on: Product & Services BRD v3.3 (Ayphen Books) adapted for Indian retail POS context*
