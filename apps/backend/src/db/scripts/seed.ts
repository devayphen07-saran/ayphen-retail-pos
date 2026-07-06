/**
 * db:seed — inserts reference / master data into a freshly migrated database.
 * Safe to re-run: uses onConflictDoUpdate so it is idempotent.
 *
 * Seeds:
 *   - system-wide roles (USER, SUPER_ADMIN — immutable, store_fk NULL) (rbac.md §4)
 *   - subscription plans (+ entitlements + features); 'free' is the trial plan
 *   - sequences (order, refund, adjustment)
 *
 * STORE_OWNER is NOT seeded here: it is a system role but store-scoped
 * (store_fk set), created per store by the store-creation flow.
 * Account ownership is accounts.owner_user_fk, not a role — nothing to seed.
 *
 * Usage:  pnpm db:seed
 * Full reset:  pnpm db:flush && pnpm db:seed
 */
import 'dotenv/config';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import * as schema from '../schema.js';
import { ENTITIES } from '#common/rbac/permission-matrix.constants.js';
import { createPgClient } from '../create-pg-client.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('[seed] DATABASE_URL is not set');
  process.exit(1);
}

// statementTimeoutMs: 0 — seeding runs large idempotent upserts that can exceed
// the app-level statement timeout.
const client = createPgClient(url, { max: 1, statementTimeoutMs: 0 });
const db = drizzle(client, { schema });

// ─── System roles ─────────────────────────────────────────────────────────────
// Immutable (isEditable=false), system-wide (storeFk=NULL). Custom roles
// (manager/cashier/accountant) are store-scoped and seeded per store from
// DEFAULT_ROLE_CRUD when an owner creates them (rbac.md §4, §9).

const SYSTEM_ROLES = [
  { code: 'USER', name: 'User' },
  { code: 'SUPER_ADMIN', name: 'Super Admin' },
] as const;

// ─── Subscription plans ─────────────────────────────────────────────────────────
// 'free' is the plan every new signup starts on (15-day trial). Entitlement
// value null = unlimited (rbac.md §26.6). Features default off unless listed true.

const PLANS = [
  {
    name: 'free',
    displayName: 'Free',
    entitlements: {
      max_stores:              1,
      max_locations_per_store: 1,
      max_devices_per_store:   1,
      max_users_per_store:     1,
      max_products:            100,
    },
    features: {
      barcode_scanning: false,
      advanced_reports: false,
      offline_mode:     true,
      // Free's max_locations_per_store is already 1, so this gate is belt-
      // and-suspenders, not the primary limiter — but it must still be an
      // explicit `false` row, not an absent one (LocationService.createLocation
      // treats a missing plan_features row as "not entitled", same as `false`).
      multi_store:      false,
    },
  },
  {
    name: 'starter',
    displayName: 'Starter',
    entitlements: {
      max_stores:              1,
      max_locations_per_store: 3,
      max_devices_per_store:   5,
      max_users_per_store:     10,
      max_products:            2000,
    },
    features: {
      barcode_scanning: true,
      advanced_reports: false,
      offline_mode:     true,
      multi_store:      true,
    },
  },
  {
    name: 'growth',
    displayName: 'Growth',
    entitlements: {
      max_stores:              null,  // unlimited
      max_locations_per_store: null,
      max_devices_per_store:   20,
      max_users_per_store:     null,
      max_products:            null,
    },
    features: {
      barcode_scanning: true,
      advanced_reports: true,
      offline_mode:     true,
      multi_store:      true,
    },
  },
] as const;

// ─── Lookup types + global values (lookup-entity-prd.md §8) ──────────────────
// System-seeded (is_system=true, storeFk=null) reference data for the ~15 POS
// dropdown categories. Everything logic-bearing (order.status, tracking_type,
// …) stays a text enum and is intentionally NOT seeded here (D1).

const LOOKUP_TYPES = [
  {
    code: 'PAYMENT_TERMS', title: 'Payment Terms',
    values: [
      { code: 'COD',   label: 'Cash on Delivery' },
      { code: 'NET7',  label: 'Net 7' },
      { code: 'NET15', label: 'Net 15' },
      { code: 'NET30', label: 'Net 30' },
    ],
  },
  {
    code: 'CUSTOMER_TYPE', title: 'Customer Type',
    values: [
      { code: 'WALK_IN',   label: 'Walk-in' },
      { code: 'REGULAR',   label: 'Regular' },
      { code: 'WHOLESALE', label: 'Wholesale' },
      { code: 'B2B',       label: 'B2B' },
    ],
  },
  {
    code: 'SUPPLIER_TYPE', title: 'Supplier Type',
    values: [
      { code: 'DISTRIBUTOR',  label: 'Distributor' },
      { code: 'MANUFACTURER', label: 'Manufacturer' },
      { code: 'LOCAL',        label: 'Local' },
    ],
  },
  {
    code: 'REASONS', title: 'Reasons',
    values: [
      { code: 'DAMAGED',         label: 'Damaged' },
      { code: 'EXPIRED',         label: 'Expired' },
      { code: 'WRONG_ITEM',      label: 'Wrong Item' },
      { code: 'CUSTOMER_RETURN', label: 'Customer Return' },
      { code: 'STOCK_COUNT',     label: 'Stock Count' },
    ],
  },
  {
    code: 'EXPENSE_CATEGORY', title: 'Expense Categories',
    values: [
      { code: 'RENT',      label: 'Rent' },
      { code: 'UTILITIES', label: 'Utilities' },
      { code: 'SALARY',    label: 'Salary' },
      { code: 'SUPPLIES',  label: 'Supplies' },
      { code: 'TRANSPORT', label: 'Transport' },
    ],
  },
  {
    code: 'CHARGES', title: 'Charges',
    values: [
      { code: 'PACKING',  label: 'Packing' },
      { code: 'DELIVERY', label: 'Delivery' },
      { code: 'SERVICE',  label: 'Service' },
    ],
  },
  {
    code: 'DISCOUNT_TYPE', title: 'Discount Type',
    values: [
      { code: 'PERCENT', label: 'Percent' },
      { code: 'FLAT',    label: 'Flat' },
      { code: 'SCHEME',  label: 'Scheme' },
    ],
  },
  {
    code: 'DELIVERY_OPTION', title: 'Delivery Options',
    values: [
      { code: 'PICKUP',        label: 'Pickup' },
      { code: 'HOME_DELIVERY', label: 'Home Delivery' },
      { code: 'COURIER',       label: 'Courier' },
    ],
  },
  {
    code: 'DELIVERY_CONDITION', title: 'Delivery Condition',
    values: [
      { code: 'GOOD',     label: 'Good' },
      { code: 'DAMAGED',  label: 'Damaged' },
      { code: 'PARTIAL',  label: 'Partial' },
    ],
  },
  {
    code: 'STORAGE_TYPE', title: 'Storage Type',
    values: [
      { code: 'AMBIENT', label: 'Ambient' },
      { code: 'CHILLED', label: 'Chilled' },
      { code: 'FROZEN',  label: 'Frozen' },
    ],
  },
  {
    code: 'ADDRESS_TYPE', title: 'Address Type',
    values: [
      { code: 'BILLING',    label: 'Billing' },
      { code: 'SHIPPING',   label: 'Shipping' },
      { code: 'REGISTERED', label: 'Registered' },
    ],
  },
  {
    code: 'COMMUNICATION_TYPE', title: 'Communication Type',
    values: [
      { code: 'PHONE',    label: 'Phone' },
      { code: 'EMAIL',    label: 'Email' },
      { code: 'WHATSAPP', label: 'WhatsApp' },
    ],
  },
  {
    code: 'CONTACT_PERSON_TYPE', title: 'Contact Person Type',
    values: [
      { code: 'PRIMARY',   label: 'Primary' },
      { code: 'ACCOUNTS',  label: 'Accounts' },
      { code: 'LOGISTICS', label: 'Logistics' },
    ],
  },
  {
    code: 'TITLE', title: 'Salutation',
    values: [
      { code: 'MR',  label: 'Mr.' },
      { code: 'MS',  label: 'Ms.' },
      { code: 'MRS', label: 'Mrs.' },
    ],
  },
  {
    code: 'NOTIFICATION_TYPE', title: 'Notification Type',
    values: [
      { code: 'ORDER',   label: 'Order' },
      { code: 'STOCK',   label: 'Stock' },
      { code: 'PAYMENT', label: 'Payment' },
      { code: 'SYSTEM',  label: 'System' },
    ],
  },
  {
    code: 'NOTIFICATION_PRIORITY', title: 'Notification Priority',
    values: [
      { code: 'LOW',      label: 'Low' },
      { code: 'NORMAL',   label: 'Normal' },
      { code: 'HIGH',     label: 'High' },
      { code: 'CRITICAL', label: 'Critical' },
    ],
  },
  {
    code: 'BUSINESS_CATEGORY', title: 'Business Category',
    values: [
      { code: 'GROCERY',       label: 'Grocery' },
      { code: 'PHARMACY',      label: 'Pharmacy' },
      { code: 'ELECTRONICS',   label: 'Electronics' },
      { code: 'CLOTHING',      label: 'Clothing & Apparel' },
      { code: 'RESTAURANT',    label: 'Restaurant / Food' },
      { code: 'HARDWARE',      label: 'Hardware & Building Supplies' },
      { code: 'STATIONERY',    label: 'Stationery & Books' },
      { code: 'BEAUTY',        label: 'Beauty & Cosmetics' },
      { code: 'GENERAL_STORE', label: 'General Store' },
      { code: 'OTHER',         label: 'Other' },
    ],
  },
  {
    code: 'GST_REGISTRATION_TYPE', title: 'GST Registration Type',
    values: [
      { code: 'REGULAR',     label: 'Regular GST' },
      { code: 'COMPOSITION', label: 'Composition Scheme' },
    ],
  },
  {
    // code = 2-digit GST state code (also used as address.state_code), label = state/UT name.
    code: 'STATE', title: 'State / Union Territory',
    values: [
      { code: '01', label: 'Jammu and Kashmir' },
      { code: '02', label: 'Himachal Pradesh' },
      { code: '03', label: 'Punjab' },
      { code: '04', label: 'Chandigarh' },
      { code: '05', label: 'Uttarakhand' },
      { code: '06', label: 'Haryana' },
      { code: '07', label: 'Delhi' },
      { code: '08', label: 'Rajasthan' },
      { code: '09', label: 'Uttar Pradesh' },
      { code: '10', label: 'Bihar' },
      { code: '11', label: 'Sikkim' },
      { code: '12', label: 'Arunachal Pradesh' },
      { code: '13', label: 'Nagaland' },
      { code: '14', label: 'Manipur' },
      { code: '15', label: 'Mizoram' },
      { code: '16', label: 'Tripura' },
      { code: '17', label: 'Meghalaya' },
      { code: '18', label: 'Assam' },
      { code: '19', label: 'West Bengal' },
      { code: '20', label: 'Jharkhand' },
      { code: '21', label: 'Odisha' },
      { code: '22', label: 'Chhattisgarh' },
      { code: '23', label: 'Madhya Pradesh' },
      { code: '24', label: 'Gujarat' },
      { code: '26', label: 'Dadra and Nagar Haveli and Daman and Diu' },
      { code: '27', label: 'Maharashtra' },
      { code: '29', label: 'Karnataka' },
      { code: '30', label: 'Goa' },
      { code: '31', label: 'Lakshadweep' },
      { code: '32', label: 'Kerala' },
      { code: '33', label: 'Tamil Nadu' },
      { code: '34', label: 'Puducherry' },
      { code: '35', label: 'Andaman and Nicobar Islands' },
      { code: '36', label: 'Telangana' },
      { code: '37', label: 'Andhra Pradesh' },
      { code: '38', label: 'Ladakh' },
    ],
  },
] as const;

// ─── Countries (ISO 3166-1 alpha-2) ──────────────────────────────────────────
// A working common-country set, not the full ISO-3166 list (195 countries) —
// covers the target market (India) plus the world's other major economies.

const COUNTRIES = [
  { code: 'IN', name: 'India',                  callingCode: '+91' },
  { code: 'US', name: 'United States',          callingCode: '+1' },
  { code: 'GB', name: 'United Kingdom',         callingCode: '+44' },
  { code: 'AE', name: 'United Arab Emirates',   callingCode: '+971' },
  { code: 'SA', name: 'Saudi Arabia',           callingCode: '+966' },
  { code: 'SG', name: 'Singapore',              callingCode: '+65' },
  { code: 'MY', name: 'Malaysia',               callingCode: '+60' },
  { code: 'AU', name: 'Australia',              callingCode: '+61' },
  { code: 'CA', name: 'Canada',                 callingCode: '+1' },
  { code: 'DE', name: 'Germany',                callingCode: '+49' },
  { code: 'FR', name: 'France',                 callingCode: '+33' },
  { code: 'IT', name: 'Italy',                  callingCode: '+39' },
  { code: 'ES', name: 'Spain',                  callingCode: '+34' },
  { code: 'NL', name: 'Netherlands',             callingCode: '+31' },
  { code: 'CH', name: 'Switzerland',             callingCode: '+41' },
  { code: 'SE', name: 'Sweden',                  callingCode: '+46' },
  { code: 'JP', name: 'Japan',                   callingCode: '+81' },
  { code: 'CN', name: 'China',                   callingCode: '+86' },
  { code: 'KR', name: 'South Korea',             callingCode: '+82' },
  { code: 'HK', name: 'Hong Kong',               callingCode: '+852' },
  { code: 'ID', name: 'Indonesia',               callingCode: '+62' },
  { code: 'TH', name: 'Thailand',                callingCode: '+66' },
  { code: 'VN', name: 'Vietnam',                 callingCode: '+84' },
  { code: 'PH', name: 'Philippines',             callingCode: '+63' },
  { code: 'PK', name: 'Pakistan',                callingCode: '+92' },
  { code: 'BD', name: 'Bangladesh',              callingCode: '+880' },
  { code: 'LK', name: 'Sri Lanka',               callingCode: '+94' },
  { code: 'NP', name: 'Nepal',                   callingCode: '+977' },
  { code: 'BT', name: 'Bhutan',                  callingCode: '+975' },
  { code: 'MM', name: 'Myanmar',                 callingCode: '+95' },
  { code: 'ZA', name: 'South Africa',            callingCode: '+27' },
  { code: 'NG', name: 'Nigeria',                 callingCode: '+234' },
  { code: 'KE', name: 'Kenya',                   callingCode: '+254' },
  { code: 'EG', name: 'Egypt',                   callingCode: '+20' },
  { code: 'BR', name: 'Brazil',                  callingCode: '+55' },
  { code: 'MX', name: 'Mexico',                  callingCode: '+52' },
  { code: 'AR', name: 'Argentina',               callingCode: '+54' },
  { code: 'NZ', name: 'New Zealand',             callingCode: '+64' },
  { code: 'QA', name: 'Qatar',                   callingCode: '+974' },
  { code: 'KW', name: 'Kuwait',                  callingCode: '+965' },
  { code: 'OM', name: 'Oman',                    callingCode: '+968' },
  { code: 'BH', name: 'Bahrain',                 callingCode: '+973' },
] as const;

// ─── Currencies (ISO 4217) ───────────────────────────────────────────────────

const CURRENCIES = [
  { code: 'INR', name: 'Indian Rupee',        symbol: '₹' },
  { code: 'USD', name: 'US Dollar',           symbol: '$' },
  { code: 'EUR', name: 'Euro',                symbol: '€' },
  { code: 'GBP', name: 'British Pound',       symbol: '£' },
  { code: 'AED', name: 'UAE Dirham',          symbol: 'د.إ' },
  { code: 'SAR', name: 'Saudi Riyal',         symbol: '﷼' },
  { code: 'SGD', name: 'Singapore Dollar',    symbol: 'S$' },
  { code: 'MYR', name: 'Malaysian Ringgit',   symbol: 'RM' },
  { code: 'AUD', name: 'Australian Dollar',   symbol: 'A$' },
  { code: 'CAD', name: 'Canadian Dollar',     symbol: 'C$' },
  { code: 'CHF', name: 'Swiss Franc',         symbol: 'CHF' },
  { code: 'SEK', name: 'Swedish Krona',       symbol: 'kr' },
  { code: 'JPY', name: 'Japanese Yen',        symbol: '¥' },
  { code: 'CNY', name: 'Chinese Yuan',        symbol: '¥' },
  { code: 'KRW', name: 'South Korean Won',    symbol: '₩' },
  { code: 'HKD', name: 'Hong Kong Dollar',    symbol: 'HK$' },
  { code: 'IDR', name: 'Indonesian Rupiah',   symbol: 'Rp' },
  { code: 'THB', name: 'Thai Baht',           symbol: '฿' },
  { code: 'VND', name: 'Vietnamese Dong',     symbol: '₫' },
  { code: 'PHP', name: 'Philippine Peso',     symbol: '₱' },
  { code: 'PKR', name: 'Pakistani Rupee',     symbol: '₨' },
  { code: 'BDT', name: 'Bangladeshi Taka',    symbol: '৳' },
  { code: 'LKR', name: 'Sri Lankan Rupee',    symbol: 'Rs' },
  { code: 'NPR', name: 'Nepalese Rupee',      symbol: '₨' },
  { code: 'ZAR', name: 'South African Rand',  symbol: 'R' },
  { code: 'NGN', name: 'Nigerian Naira',      symbol: '₦' },
  { code: 'BRL', name: 'Brazilian Real',      symbol: 'R$' },
  { code: 'MXN', name: 'Mexican Peso',        symbol: 'MX$' },
  { code: 'NZD', name: 'New Zealand Dollar',  symbol: 'NZ$' },
  { code: 'QAR', name: 'Qatari Riyal',        symbol: 'ر.ق' },
  { code: 'KWD', name: 'Kuwaiti Dinar',       symbol: 'د.ك' },
  { code: 'OMR', name: 'Omani Rial',          symbol: 'ر.ع.' },
  { code: 'BHD', name: 'Bahraini Dinar',      symbol: '.د.ب' },
] as const;

// ─── Sequences ────────────────────────────────────────────────────────────────

const SEQUENCES = [
  { type: 'order', prefix: 'ORD', counter: 0, year: new Date().getFullYear() },
  { type: 'refund', prefix: 'REF', counter: 0, year: new Date().getFullYear() },
  {
    type: 'adjustment',
    prefix: 'ADJ',
    counter: 0,
    year: new Date().getFullYear(),
  },
] as const;

// ─── Runner ───────────────────────────────────────────────────────────────────

async function seed() {
  console.log('[seed] Seeding system roles...');
  for (const role of SYSTEM_ROLES) {
    await db
      .insert(schema.roles)
      .values({
        code: role.code,
        name: role.name,
        isEditable: false,
        storeFk: null,
      })
      .onConflictDoNothing();
  }
  console.log(`[seed] ${SYSTEM_ROLES.length} system roles seeded.`);

  console.log('[seed] Seeding plans...');
  for (const plan of PLANS) {
    await db
      .insert(schema.plans)
      .values({ name: plan.name, displayName: plan.displayName, isActive: true })
      .onConflictDoNothing({ target: schema.plans.name });

    const [row] = await db
      .select({ id: schema.plans.id })
      .from(schema.plans)
      .where(eq(schema.plans.name, plan.name));
    if (!row) continue;

    for (const [key, value] of Object.entries(plan.entitlements)) {
      await db
        .insert(schema.planEntitlements)
        .values({ planFk: row.id, key, value })
        .onConflictDoUpdate({
          target: [schema.planEntitlements.planFk, schema.planEntitlements.key],
          set: { value },
        });
    }
    for (const [key, enabled] of Object.entries(plan.features)) {
      await db
        .insert(schema.planFeatures)
        .values({ planFk: row.id, key, enabled })
        .onConflictDoUpdate({
          target: [schema.planFeatures.planFk, schema.planFeatures.key],
          set: { enabled },
        });
    }
  }
  console.log(`[seed] ${PLANS.length} plans seeded.`);

  console.log('[seed] Seeding entity types...');
  for (const entity of ENTITIES) {
    await db
      .insert(schema.entityTypes)
      .values({
        code:                entity.code,
        label:               entity.label,
        isOfflineSafe:       entity.isOfflineSafe,
        supportsAttachments: entity.supportsAttachments,
      })
      .onConflictDoUpdate({
        target: schema.entityTypes.code,
        set: {
          label:               entity.label,
          isOfflineSafe:       entity.isOfflineSafe,
          supportsAttachments: entity.supportsAttachments,
        },
      });
  }
  console.log(`[seed] ${ENTITIES.length} entity types seeded.`);

  console.log('[seed] Seeding lookup types + values...');
  let lookupValueCount = 0;
  for (const type of LOOKUP_TYPES) {
    await db
      .insert(schema.lookupType)
      .values({ code: type.code, title: type.title })
      .onConflictDoUpdate({
        target: schema.lookupType.code,
        set: { title: type.title },
      });

    const [row] = await db
      .select({ id: schema.lookupType.id })
      .from(schema.lookupType)
      .where(eq(schema.lookupType.code, type.code));
    if (!row) continue;

    for (const [index, value] of type.values.entries()) {
      await db
        .insert(schema.lookup)
        .values({
          lookupTypeFk: row.id,
          storeFk:      null, // global seed value
          code:         value.code,
          label:        value.label,
          sortOrder:    index + 1,
          isSystem:     true,
        })
        .onConflictDoUpdate({
          target: [schema.lookup.lookupTypeFk, schema.lookup.code],
          set: { label: value.label, sortOrder: index + 1 },
        });
      lookupValueCount++;
    }
  }
  console.log(`[seed] ${LOOKUP_TYPES.length} lookup types / ${lookupValueCount} lookup values seeded.`);

  console.log('[seed] Seeding countries...');
  for (const c of COUNTRIES) {
    await db
      .insert(schema.country)
      .values({ code: c.code, name: c.name, callingCode: c.callingCode })
      .onConflictDoUpdate({
        target: schema.country.code,
        set: { name: c.name, callingCode: c.callingCode },
      });
  }
  console.log(`[seed] ${COUNTRIES.length} countries seeded.`);

  console.log('[seed] Seeding currencies...');
  for (const c of CURRENCIES) {
    await db
      .insert(schema.currency)
      .values({ code: c.code, name: c.name, symbol: c.symbol })
      .onConflictDoUpdate({
        target: schema.currency.code,
        set: { name: c.name, symbol: c.symbol },
      });
  }
  console.log(`[seed] ${CURRENCIES.length} currencies seeded.`);

  console.log('[seed] Seeding sequences...');
  for (const seq of SEQUENCES) {
    await db
      .insert(schema.sequences)
      .values(seq)
      .onConflictDoUpdate({
        target: schema.sequences.type,
        set: { prefix: seq.prefix, year: seq.year },
      });
  }
  console.log(`[seed] ${SEQUENCES.length} sequences seeded.`);

  console.log('[seed] Done.');
  await client.end();
}

seed().catch((err) => {
  console.error('[seed] Failed:', err);
  process.exit(1);
});
