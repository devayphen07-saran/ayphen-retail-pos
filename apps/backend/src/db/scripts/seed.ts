import 'dotenv/config';

import { and, eq, isNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';

import { ENTITIES } from '#common/rbac/permission-matrix.constants.js';

import * as schema from '../schema.js';
import { createPgClient } from '../create-pg-client.js';

// ─── Reference data ──────────────────────────────────────────────────────────

/*
 * System roles: immutable (isEditable=false), system-wide (storeFk=NULL). Custom
 * roles (manager/cashier/accountant) are store-scoped and seeded per store from
 * DEFAULT_ROLE_CRUD when an owner creates them (rbac.md §4, §9). STORE_OWNER is a
 * system role but store-scoped, so it is created by the store-creation flow.
 */
const SYSTEM_ROLES = [
  { code: 'USER', name: 'User' },
  { code: 'SUPER_ADMIN', name: 'Super Admin' },
] as const;

/*
 * Subscription plans. 'free' is the plan every new signup starts on (15-day
 * trial). Entitlement value null = unlimited (rbac.md §26.6). Features default
 * off unless listed true.
 */
const PLANS = [
  {
    name: 'free',
    displayName: 'Free',
    entitlements: {
      max_stores: 1,
      max_devices_per_store: 1,
      max_products: 10,
    },
    features: {
      barcode_scanning: false,
      advanced_reports: false,
      offline_mode: true,
    },
  },
  {
    name: 'starter',
    displayName: 'Starter',
    entitlements: {
      max_stores: 1,
      max_devices_per_store: 5,
      max_products: 100,
    },
    features: {
      barcode_scanning: true,
      advanced_reports: false,
      offline_mode: true,
    },
  },
  {
    name: 'growth',
    displayName: 'Growth',
    entitlements: {
      max_stores: null, // unlimited
      max_devices_per_store: 20,
      max_products: null,
    },
    features: {
      barcode_scanning: true,
      advanced_reports: true,
      offline_mode: true,
    },
  },
] as const;

/*
 * Lookup types + global values (lookup-entity-prd.md §8). System-seeded
 * (isSystem=true, storeFk=null) reference data for the POS dropdown categories.
 * Everything logic-bearing (order.status, tracking_type, …) stays a text enum
 * and is intentionally NOT seeded here (D1).
 */
const LOOKUP_TYPES = [
  {
    code: 'PAYMENT_TERMS',
    title: 'Payment Terms',
    values: [
      { code: 'COD', label: 'Cash on Delivery' },
      { code: 'NET7', label: 'Net 7' },
      { code: 'NET15', label: 'Net 15' },
      { code: 'NET30', label: 'Net 30' },
    ],
  },
  {
    code: 'CUSTOMER_TYPE',
    title: 'Customer Type',
    values: [
      { code: 'WALK_IN', label: 'Walk-in' },
      { code: 'REGULAR', label: 'Regular' },
      { code: 'WHOLESALE', label: 'Wholesale' },
      { code: 'B2B', label: 'B2B' },
    ],
  },
  {
    code: 'SUPPLIER_TYPE',
    title: 'Supplier Type',
    values: [
      { code: 'DISTRIBUTOR', label: 'Distributor' },
      { code: 'MANUFACTURER', label: 'Manufacturer' },
      { code: 'LOCAL', label: 'Local' },
    ],
  },
  {
    code: 'REASONS',
    title: 'Reasons',
    values: [
      { code: 'DAMAGED', label: 'Damaged' },
      { code: 'EXPIRED', label: 'Expired' },
      { code: 'WRONG_ITEM', label: 'Wrong Item' },
      { code: 'CUSTOMER_RETURN', label: 'Customer Return' },
      { code: 'STOCK_COUNT', label: 'Stock Count' },
    ],
  },
  {
    code: 'EXPENSE_CATEGORY',
    title: 'Expense Categories',
    values: [
      { code: 'RENT', label: 'Rent' },
      { code: 'UTILITIES', label: 'Utilities' },
      { code: 'SALARY', label: 'Salary' },
      { code: 'SUPPLIES', label: 'Supplies' },
      { code: 'TRANSPORT', label: 'Transport' },
    ],
  },
  {
    code: 'CHARGES',
    title: 'Charges',
    values: [
      { code: 'PACKING', label: 'Packing' },
      { code: 'DELIVERY', label: 'Delivery' },
      { code: 'SERVICE', label: 'Service' },
    ],
  },
  {
    code: 'DISCOUNT_TYPE',
    title: 'Discount Type',
    values: [
      { code: 'PERCENT', label: 'Percent' },
      { code: 'FLAT', label: 'Flat' },
      { code: 'SCHEME', label: 'Scheme' },
    ],
  },
  {
    code: 'DELIVERY_OPTION',
    title: 'Delivery Options',
    values: [
      { code: 'PICKUP', label: 'Pickup' },
      { code: 'HOME_DELIVERY', label: 'Home Delivery' },
      { code: 'COURIER', label: 'Courier' },
    ],
  },
  {
    code: 'DELIVERY_CONDITION',
    title: 'Delivery Condition',
    values: [
      { code: 'GOOD', label: 'Good' },
      { code: 'DAMAGED', label: 'Damaged' },
      { code: 'PARTIAL', label: 'Partial' },
    ],
  },
  {
    code: 'STORAGE_TYPE',
    title: 'Storage Type',
    values: [
      { code: 'AMBIENT', label: 'Ambient' },
      { code: 'CHILLED', label: 'Chilled' },
      { code: 'FROZEN', label: 'Frozen' },
    ],
  },
  {
    code: 'ADDRESS_TYPE',
    title: 'Address Type',
    values: [
      { code: 'BILLING', label: 'Billing' },
      { code: 'SHIPPING', label: 'Shipping' },
      { code: 'REGISTERED', label: 'Registered' },
    ],
  },
  {
    code: 'COMMUNICATION_TYPE',
    title: 'Communication Type',
    values: [
      { code: 'PHONE', label: 'Phone' },
      { code: 'EMAIL', label: 'Email' },
      { code: 'WHATSAPP', label: 'WhatsApp' },
    ],
  },
  {
    code: 'CONTACT_PERSON_TYPE',
    title: 'Contact Person Type',
    values: [
      { code: 'PRIMARY', label: 'Primary' },
      { code: 'ACCOUNTS', label: 'Accounts' },
      { code: 'LOGISTICS', label: 'Logistics' },
    ],
  },
  {
    code: 'TITLE',
    title: 'Salutation',
    values: [
      { code: 'MR', label: 'Mr.' },
      { code: 'MS', label: 'Ms.' },
      { code: 'MRS', label: 'Mrs.' },
    ],
  },
  {
    code: 'NOTIFICATION_TYPE',
    title: 'Notification Type',
    values: [
      { code: 'ORDER', label: 'Order' },
      { code: 'STOCK', label: 'Stock' },
      { code: 'PAYMENT', label: 'Payment' },
      { code: 'SYSTEM', label: 'System' },
    ],
  },
  {
    code: 'NOTIFICATION_PRIORITY',
    title: 'Notification Priority',
    values: [
      { code: 'LOW', label: 'Low' },
      { code: 'NORMAL', label: 'Normal' },
      { code: 'HIGH', label: 'High' },
      { code: 'CRITICAL', label: 'Critical' },
    ],
  },
  {
    code: 'BUSINESS_CATEGORY',
    title: 'Business Category',
    values: [
      { code: 'GROCERY', label: 'Grocery' },
      { code: 'PHARMACY', label: 'Pharmacy' },
      { code: 'ELECTRONICS', label: 'Electronics' },
      { code: 'CLOTHING', label: 'Clothing & Apparel' },
      { code: 'RESTAURANT', label: 'Restaurant / Food' },
      { code: 'HARDWARE', label: 'Hardware & Building Supplies' },
      { code: 'STATIONERY', label: 'Stationery & Books' },
      { code: 'BEAUTY', label: 'Beauty & Cosmetics' },
      { code: 'GENERAL_STORE', label: 'General Store' },
      { code: 'OTHER', label: 'Other' },
    ],
  },
  {
    code: 'GST_REGISTRATION_TYPE',
    title: 'GST Registration Type',
    values: [
      { code: 'REGULAR', label: 'Regular GST' },
      { code: 'COMPOSITION', label: 'Composition Scheme' },
    ],
  },
  {
    // code = 2-digit GST state code (also used as address.state_code), label = state/UT name.
    code: 'STATE',
    title: 'State / Union Territory',
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

/*
 * Countries (ISO 3166-1 alpha-2). A working common-country set, not the full
 * ISO-3166 list — covers the target market (India) plus other major economies.
 */
const COUNTRIES = [
  { code: 'IN', name: 'India', callingCode: '+91' },
  { code: 'US', name: 'United States', callingCode: '+1' },
  { code: 'GB', name: 'United Kingdom', callingCode: '+44' },
  { code: 'AE', name: 'United Arab Emirates', callingCode: '+971' },
  { code: 'SA', name: 'Saudi Arabia', callingCode: '+966' },
  { code: 'SG', name: 'Singapore', callingCode: '+65' },
  { code: 'MY', name: 'Malaysia', callingCode: '+60' },
  { code: 'AU', name: 'Australia', callingCode: '+61' },
  { code: 'CA', name: 'Canada', callingCode: '+1' },
  { code: 'DE', name: 'Germany', callingCode: '+49' },
  { code: 'FR', name: 'France', callingCode: '+33' },
  { code: 'IT', name: 'Italy', callingCode: '+39' },
  { code: 'ES', name: 'Spain', callingCode: '+34' },
  { code: 'NL', name: 'Netherlands', callingCode: '+31' },
  { code: 'CH', name: 'Switzerland', callingCode: '+41' },
  { code: 'SE', name: 'Sweden', callingCode: '+46' },
  { code: 'JP', name: 'Japan', callingCode: '+81' },
  { code: 'CN', name: 'China', callingCode: '+86' },
  { code: 'KR', name: 'South Korea', callingCode: '+82' },
  { code: 'HK', name: 'Hong Kong', callingCode: '+852' },
  { code: 'ID', name: 'Indonesia', callingCode: '+62' },
  { code: 'TH', name: 'Thailand', callingCode: '+66' },
  { code: 'VN', name: 'Vietnam', callingCode: '+84' },
  { code: 'PH', name: 'Philippines', callingCode: '+63' },
  { code: 'PK', name: 'Pakistan', callingCode: '+92' },
  { code: 'BD', name: 'Bangladesh', callingCode: '+880' },
  { code: 'LK', name: 'Sri Lanka', callingCode: '+94' },
  { code: 'NP', name: 'Nepal', callingCode: '+977' },
  { code: 'BT', name: 'Bhutan', callingCode: '+975' },
  { code: 'MM', name: 'Myanmar', callingCode: '+95' },
  { code: 'ZA', name: 'South Africa', callingCode: '+27' },
  { code: 'NG', name: 'Nigeria', callingCode: '+234' },
  { code: 'KE', name: 'Kenya', callingCode: '+254' },
  { code: 'EG', name: 'Egypt', callingCode: '+20' },
  { code: 'BR', name: 'Brazil', callingCode: '+55' },
  { code: 'MX', name: 'Mexico', callingCode: '+52' },
  { code: 'AR', name: 'Argentina', callingCode: '+54' },
  { code: 'NZ', name: 'New Zealand', callingCode: '+64' },
  { code: 'QA', name: 'Qatar', callingCode: '+974' },
  { code: 'KW', name: 'Kuwait', callingCode: '+965' },
  { code: 'OM', name: 'Oman', callingCode: '+968' },
  { code: 'BH', name: 'Bahrain', callingCode: '+973' },
] as const;

// Currencies (ISO 4217).
const CURRENCIES = [
  { code: 'INR', name: 'Indian Rupee', symbol: '₹' },
  { code: 'USD', name: 'US Dollar', symbol: '$' },
  { code: 'EUR', name: 'Euro', symbol: '€' },
  { code: 'GBP', name: 'British Pound', symbol: '£' },
  { code: 'AED', name: 'UAE Dirham', symbol: 'د.إ' },
  { code: 'SAR', name: 'Saudi Riyal', symbol: '﷼' },
  { code: 'SGD', name: 'Singapore Dollar', symbol: 'S$' },
  { code: 'MYR', name: 'Malaysian Ringgit', symbol: 'RM' },
  { code: 'AUD', name: 'Australian Dollar', symbol: 'A$' },
  { code: 'CAD', name: 'Canadian Dollar', symbol: 'C$' },
  { code: 'CHF', name: 'Swiss Franc', symbol: 'CHF' },
  { code: 'SEK', name: 'Swedish Krona', symbol: 'kr' },
  { code: 'JPY', name: 'Japanese Yen', symbol: '¥' },
  { code: 'CNY', name: 'Chinese Yuan', symbol: '¥' },
  { code: 'KRW', name: 'South Korean Won', symbol: '₩' },
  { code: 'HKD', name: 'Hong Kong Dollar', symbol: 'HK$' },
  { code: 'IDR', name: 'Indonesian Rupiah', symbol: 'Rp' },
  { code: 'THB', name: 'Thai Baht', symbol: '฿' },
  { code: 'VND', name: 'Vietnamese Dong', symbol: '₫' },
  { code: 'PHP', name: 'Philippine Peso', symbol: '₱' },
  { code: 'PKR', name: 'Pakistani Rupee', symbol: '₨' },
  { code: 'BDT', name: 'Bangladeshi Taka', symbol: '৳' },
  { code: 'LKR', name: 'Sri Lankan Rupee', symbol: 'Rs' },
  { code: 'NPR', name: 'Nepalese Rupee', symbol: '₨' },
  { code: 'ZAR', name: 'South African Rand', symbol: 'R' },
  { code: 'NGN', name: 'Nigerian Naira', symbol: '₦' },
  { code: 'BRL', name: 'Brazilian Real', symbol: 'R$' },
  { code: 'MXN', name: 'Mexican Peso', symbol: 'MX$' },
  { code: 'NZD', name: 'New Zealand Dollar', symbol: 'NZ$' },
  { code: 'QAR', name: 'Qatari Riyal', symbol: 'ر.ق' },
  { code: 'KWD', name: 'Kuwaiti Dinar', symbol: 'د.ك' },
  { code: 'OMR', name: 'Omani Rial', symbol: 'ر.ع.' },
  { code: 'BHD', name: 'Bahraini Dinar', symbol: '.د.ب' },
] as const;

// Sequences. counter starts at 0 and is never reset on re-seed (see seedSequences).
const CURRENT_YEAR = new Date().getFullYear();

const SEQUENCES = [
  { type: 'order', prefix: 'ORD', counter: 0, year: CURRENT_YEAR },
  { type: 'refund', prefix: 'REF', counter: 0, year: CURRENT_YEAR },
  { type: 'adjustment', prefix: 'ADJ', counter: 0, year: CURRENT_YEAR },
] as const;

// ─── File configuration ──────────────────────────────────────────────────────

const MB = 1024 * 1024;

const FILE_CONFIG_COMMON = {
  maxFileSizeBytes: 10 * MB,
  maxConsolidatedSizeBytes: 50 * MB,
  maxAttachmentsAllowed: 10,
  isActive: true,
} as const;

/**
 * The image-specific rule prevents a valid PDF from being committed while the
 * client declares kind=image.
 *
 * The null rule is an entity-wide fallback for document-style attachments.
 * SVG remains deliberately excluded.
 */
const FILE_CONFIG_RULES = [
  {
    fileKind: null,
    validExtensions: 'jpg,jpeg,png,webp,gif,pdf',
  },
  {
    fileKind: 'image',
    validExtensions: 'jpg,jpeg,png,webp,gif',
  },
] as const;

// ─── Database setup ──────────────────────────────────────────────────────────

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error('[seed] DATABASE_URL is not set');
}

const client = createPgClient(databaseUrl, {
  max: 1,
  statementTimeoutMs: 0,
});

const db = drizzle(client, { schema });

// ─── Seed functions ──────────────────────────────────────────────────────────

async function seedSystemRoles(): Promise<void> {
  console.log('[seed] Seeding system roles...');

  for (const role of SYSTEM_ROLES) {
    /*
     * roles_system_code_uq is a partial unique index, so it may not be usable as
     * a regular ON CONFLICT target through Drizzle. Update first, then insert if
     * no system role exists.
     */
    const [updated] = await db
      .update(schema.roles)
      .set({
        name: role.name,
        isEditable: false,
      })
      .where(
        and(eq(schema.roles.code, role.code), isNull(schema.roles.storeFk)),
      )
      .returning({ id: schema.roles.id });

    if (!updated) {
      await db.insert(schema.roles).values({
        code: role.code,
        name: role.name,
        isEditable: false,
        storeFk: null,
      });
    }
  }

  console.log(`[seed] ${SYSTEM_ROLES.length} system roles seeded.`);
}

async function seedPlans(): Promise<void> {
  console.log('[seed] Seeding subscription plans...');

  for (const plan of PLANS) {
    const [planRow] = await db
      .insert(schema.plans)
      .values({
        name: plan.name,
        displayName: plan.displayName,
        isActive: true,
      })
      .onConflictDoUpdate({
        target: schema.plans.name,
        set: {
          displayName: plan.displayName,
          isActive: true,
        },
      })
      .returning({ id: schema.plans.id });

    if (!planRow) {
      throw new Error(`[seed] Failed to upsert plan ${plan.name}`);
    }

    for (const [key, value] of Object.entries(plan.entitlements)) {
      await db
        .insert(schema.planEntitlements)
        .values({
          planFk: planRow.id,
          key,
          value,
        })
        .onConflictDoUpdate({
          target: [schema.planEntitlements.planFk, schema.planEntitlements.key],
          set: { value },
        });
    }

    for (const [key, enabled] of Object.entries(plan.features)) {
      await db
        .insert(schema.planFeatures)
        .values({
          planFk: planRow.id,
          key,
          enabled,
        })
        .onConflictDoUpdate({
          target: [schema.planFeatures.planFk, schema.planFeatures.key],
          set: { enabled },
        });
    }
  }

  console.log(`[seed] ${PLANS.length} subscription plans seeded.`);
}

async function seedEntityTypes(): Promise<Map<string, string>> {
  console.log('[seed] Seeding entity types...');

  const entityIds = new Map<string, string>();

  for (const entity of ENTITIES) {
    const [row] = await db
      .insert(schema.entityTypes)
      .values({
        code: entity.code,
        label: entity.label,
        isOfflineSafe: entity.isOfflineSafe,
        supportsAttachments: entity.supportsAttachments,
      })
      .onConflictDoUpdate({
        target: schema.entityTypes.code,
        set: {
          label: entity.label,
          isOfflineSafe: entity.isOfflineSafe,
          supportsAttachments: entity.supportsAttachments,
        },
      })
      .returning({
        id: schema.entityTypes.id,
        code: schema.entityTypes.code,
      });

    if (!row) {
      throw new Error(`[seed] Failed to upsert entity type ${entity.code}`);
    }

    entityIds.set(row.code, row.id);
  }

  console.log(`[seed] ${ENTITIES.length} entity types seeded.`);

  return entityIds;
}

async function seedFileConfigurations(
  entityIds: Map<string, string>,
): Promise<void> {
  console.log('[seed] Seeding file configurations...');

  /*
   * Prevent two concurrently running seed processes from performing the
   * nullable fallback-rule update/insert sequence simultaneously.
   */
  await db.execute(
    sql`select pg_advisory_lock(hashtext('db-seed:files-config'))`,
  );

  let seededCount = 0;

  try {
    for (const entity of ENTITIES) {
      if (!entity.supportsAttachments) {
        continue;
      }

      const entityTypeFk = entityIds.get(entity.code);

      if (!entityTypeFk) {
        throw new Error(`[seed] Missing entity type id for ${entity.code}`);
      }

      for (const rule of FILE_CONFIG_RULES) {
        const values = {
          entityTypeFk,
          fileKind: rule.fileKind,
          validExtensions: rule.validExtensions,
          ...FILE_CONFIG_COMMON,
        };

        if (rule.fileKind === null) {
          /*
           * This explicit update also works before the NULLS NOT DISTINCT
           * migration is deployed. After the migration, the subsequent insert
           * is protected against concurrent duplicates as well.
           */
          const [updated] = await db
            .update(schema.filesConfig)
            .set({
              validExtensions: rule.validExtensions,
              ...FILE_CONFIG_COMMON,
            })
            .where(
              and(
                eq(schema.filesConfig.entityTypeFk, entityTypeFk),
                isNull(schema.filesConfig.fileKind),
              ),
            )
            .returning({
              id: schema.filesConfig.id,
            });

          if (!updated) {
            await db.insert(schema.filesConfig).values(values);
          }
        } else {
          await db
            .insert(schema.filesConfig)
            .values(values)
            .onConflictDoUpdate({
              target: [
                schema.filesConfig.entityTypeFk,
                schema.filesConfig.fileKind,
              ],
              set: {
                validExtensions: rule.validExtensions,
                ...FILE_CONFIG_COMMON,
              },
            });
        }

        seededCount += 1;
      }
    }
  } finally {
    await db.execute(
      sql`select pg_advisory_unlock(hashtext('db-seed:files-config'))`,
    );
  }

  console.log(`[seed] ${seededCount} file configuration rules seeded.`);
}

async function seedLookupTypesAndValues(): Promise<void> {
  console.log('[seed] Seeding lookup types and values...');

  let lookupValueCount = 0;

  for (const type of LOOKUP_TYPES) {
    const [lookupType] = await db
      .insert(schema.lookupType)
      .values({
        code: type.code,
        title: type.title,
      })
      .onConflictDoUpdate({
        target: schema.lookupType.code,
        set: {
          title: type.title,
        },
      })
      .returning({
        id: schema.lookupType.id,
      });

    if (!lookupType) {
      throw new Error(`[seed] Failed to upsert lookup type ${type.code}`);
    }

    for (const [index, value] of type.values.entries()) {
      await db
        .insert(schema.lookup)
        .values({
          lookupTypeFk: lookupType.id,
          storeFk: null,
          code: value.code,
          label: value.label,
          sortOrder: index + 1,
          isSystem: true,
        })
        .onConflictDoUpdate({
          target: [schema.lookup.lookupTypeFk, schema.lookup.code],
          set: {
            label: value.label,
            sortOrder: index + 1,
            isSystem: true,
            storeFk: null,
          },
        });

      lookupValueCount += 1;
    }
  }

  console.log(
    `[seed] ${LOOKUP_TYPES.length} lookup types and ` +
      `${lookupValueCount} lookup values seeded.`,
  );
}

async function seedCountries(): Promise<void> {
  console.log('[seed] Seeding countries...');

  for (const country of COUNTRIES) {
    await db
      .insert(schema.country)
      .values({
        code: country.code,
        name: country.name,
        callingCode: country.callingCode,
      })
      .onConflictDoUpdate({
        target: schema.country.code,
        set: {
          name: country.name,
          callingCode: country.callingCode,
        },
      });
  }

  console.log(`[seed] ${COUNTRIES.length} countries seeded.`);
}

async function seedCurrencies(): Promise<void> {
  console.log('[seed] Seeding currencies...');

  for (const currency of CURRENCIES) {
    await db
      .insert(schema.currency)
      .values({
        code: currency.code,
        name: currency.name,
        symbol: currency.symbol,
      })
      .onConflictDoUpdate({
        target: schema.currency.code,
        set: {
          name: currency.name,
          symbol: currency.symbol,
        },
      });
  }

  console.log(`[seed] ${CURRENCIES.length} currencies seeded.`);
}

async function seedSequences(): Promise<void> {
  console.log('[seed] Seeding sequences...');

  for (const sequence of SEQUENCES) {
    await db
      .insert(schema.sequences)
      .values(sequence)
      .onConflictDoUpdate({
        target: schema.sequences.type,
        set: {
          /*
           * Never reset the counter during a seed rerun.
           */
          prefix: sequence.prefix,
          year: sequence.year,
        },
      });
  }

  console.log(`[seed] ${SEQUENCES.length} sequences seeded.`);
}

// ─── Runner ──────────────────────────────────────────────────────────────────

async function seed(): Promise<void> {
  console.log('[seed] Starting database seed...');

  /*
   * Reference data is intentionally seeded in dependency order.
   *
   * Each individual upsert is idempotent. The entire seed is not wrapped in one
   * long transaction because installations may contain substantial reference
   * data and statementTimeout is intentionally disabled for this process.
   */
  await seedSystemRoles();
  await seedPlans();

  const entityIds = await seedEntityTypes();

  await seedFileConfigurations(entityIds);
  await seedLookupTypesAndValues();
  await seedCountries();
  await seedCurrencies();
  await seedSequences();

  console.log('[seed] Done.');
}

async function main(): Promise<void> {
  try {
    await seed();
  } catch (error) {
    process.exitCode = 1;

    console.error(
      '[seed] Failed:',
      error instanceof Error ? (error.stack ?? error.message) : error,
    );
  } finally {
    /*
     * Do not call process.exit(). It can terminate while buffered database work
     * or logs are still pending.
     */
    await client.end({
      timeout: 5,
    });
  }
}

void main();
