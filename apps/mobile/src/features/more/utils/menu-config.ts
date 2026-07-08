import type { LucideIconNameType } from '@ayphen/mobile-ui-components';

/**
 * Static menu config for the More tab, modeled on the reference app's
 * MORE_SECTIONS. No permission gating here (this app has no per-item
 * permission matrix yet) — every item is shown. Most items route to the
 * generic "Coming soon" placeholder until their real feature ships; a few
 * (see MoreScreen's ITEM_ROUTES) have a dedicated route already.
 */
export type MenuColorToken =
  | 'primary'
  | 'success'
  | 'warning'
  | 'error'
  | 'info'
  | 'violet'
  | 'teal'
  | 'neutral';

export interface MoreMenuItemConfig {
  readonly key: string;
  readonly label: string;
  readonly description: string;
  readonly iconName: LucideIconNameType;
  readonly iconColor: MenuColorToken;
}

export interface MoreSectionConfig {
  readonly key: string;
  readonly title: string;
  readonly description: string;
  readonly iconName: LucideIconNameType;
  readonly iconColor: MenuColorToken;
  /**
   * When set, tapping this top-level row navigates straight to `route`
   * instead of drilling into a section list. Used for standalone entries
   * (e.g. Subscription) that don't need a sub-menu. Such entries carry an
   * empty `items` array.
   */
  readonly route?: string;
  readonly items: readonly MoreMenuItemConfig[];
}

export const MORE_SECTIONS: readonly MoreSectionConfig[] = [
  {
    key: 'shift-management',
    title: 'Shift Management',
    description: 'Shifts, cash drawer, and Z-Reports',
    iconName: 'Clock3',
    iconColor: 'neutral',
    items: [
      {
        key: 'shifts',
        label: 'Shifts',
        description: 'Shift templates and schedules',
        iconName: 'Clock3',
        iconColor: 'info',
      },
      {
        key: 'cash-drawer',
        label: 'Cash Drawer',
        description: 'Safe drops and petty cash entries',
        iconName: 'LockKeyhole',
        iconColor: 'warning',
      },
      {
        key: 'z-reports',
        label: 'Z-Reports',
        description: 'End-of-shift reconciliation history',
        iconName: 'FileChartColumn',
        iconColor: 'teal',
      },
    ],
  },

  {
    key: 'sales',
    title: 'Sales',
    description: 'Orders, returns, and promotions',
    iconName: 'ShoppingBag',
    iconColor: 'primary',
    items: [
      {
        key: 'refunds',
        label: 'Refunds & Returns',
        description: 'Process returns and issue credit notes',
        iconName: 'RotateCcw',
        iconColor: 'error',
      },
      {
        key: 'promotions',
        label: 'Promotions',
        description: 'Discounts, offers, and campaigns',
        iconName: 'TicketPercent',
        iconColor: 'warning',
      },
    ],
  },

  {
    key: 'customers',
    title: 'Customers',
    description: 'Directory, credit, and advances',
    iconName: 'UsersRound',
    iconColor: 'violet',
    items: [
      {
        key: 'customer-directory',
        label: 'Customer Directory',
        description: 'Profiles, purchase history, and contacts',
        iconName: 'UsersRound',
        iconColor: 'violet',
      },
      {
        key: 'credit-ledger',
        label: 'Credit Ledger',
        description: 'Outstanding balances and payment history',
        iconName: 'BookOpen',
        iconColor: 'warning',
      },
      {
        key: 'customer-advances',
        label: 'Advances',
        description: 'Customer deposits and advance receipts',
        iconName: 'HandCoins',
        iconColor: 'success',
      },
    ],
  },

  {
    key: 'inventory',
    title: 'Inventory',
    description: 'Stock levels and adjustments',
    iconName: 'Boxes',
    iconColor: 'teal',
    items: [
      {
        key: 'stock-levels',
        label: 'Stock Levels',
        description: 'Current stock and low-stock alerts',
        iconName: 'Boxes',
        iconColor: 'violet',
      },
      {
        key: 'stock-takes',
        label: 'Stock Takes',
        description: 'Physical count and inventory reconciliation',
        iconName: 'ClipboardCheck',
        iconColor: 'teal',
      },
      {
        key: 'stock-adjustments',
        label: 'Stock Adjustments',
        description: 'Corrections for damage, theft, or audit',
        iconName: 'ClipboardList',
        iconColor: 'neutral',
      },
    ],
  },

  {
    key: 'purchases',
    title: 'Purchases',
    description: 'Suppliers, stock-in, and payables',
    iconName: 'PackageCheck',
    iconColor: 'success',
    items: [
      {
        key: 'suppliers',
        label: 'Suppliers',
        description: 'Vendor directory with GSTIN and terms',
        iconName: 'Truck',
        iconColor: 'success',
      },
      {
        key: 'purchase-orders',
        label: 'Purchase Orders',
        description: 'Record stock-in from suppliers',
        iconName: 'PackagePlus',
        iconColor: 'info',
      },
    ],
  },

  {
    key: 'finance',
    title: 'Finance',
    description: 'Cash book and expense tracking',
    iconName: 'Wallet',
    iconColor: 'warning',
    items: [
      {
        key: 'cash-book',
        label: 'Cash Book',
        description: 'Every cash inflow and outflow',
        iconName: 'Banknote',
        iconColor: 'success',
      },
      {
        key: 'expenses',
        label: 'Expenses',
        description: 'Rent, electricity, wages, and more',
        iconName: 'Receipt',
        iconColor: 'error',
      },
    ],
  },

  {
    key: 'reports',
    title: 'Reports',
    description: 'Sales, tax, profit, and exports',
    iconName: 'ChartBar',
    iconColor: 'violet',
    items: [
      {
        key: 'daily-sales',
        label: 'Daily Sales',
        description: 'Revenue, transactions, and top products',
        iconName: 'TrendingUp',
        iconColor: 'success',
      },
      {
        key: 'tax-summary',
        label: 'Tax Summary',
        description: 'CGST, SGST, IGST breakdown',
        iconName: 'Calculator',
        iconColor: 'primary',
      },
      {
        key: 'profit-loss',
        label: 'Profit & Loss',
        description: 'Revenue, COGS, expenses, net profit',
        iconName: 'ChartPie',
        iconColor: 'violet',
      },
      {
        key: 'gstr1-export',
        label: 'GSTR-1 Export',
        description: 'Excel export for CA filing',
        iconName: 'FileSpreadsheet',
        iconColor: 'teal',
      },
    ],
  },

  {
    key: 'staff-roles',
    title: 'Staff & Roles',
    description: 'Team members, roles, and invitations',
    iconName: 'UserCog',
    iconColor: 'warning',
    items: [
      {
        key: 'staff',
        label: 'Staff List',
        description: 'Team members and their access',
        iconName: 'UserCog',
        iconColor: 'warning',
      },
      {
        key: 'invite-staff',
        label: 'Invite Staff',
        description: 'Invite a team member to a role and locations',
        iconName: 'UserPlus',
        iconColor: 'success',
      },
      {
        key: 'invitations',
        label: 'My Invitations',
        description: 'View invitations sent to you',
        iconName: 'MailCheck',
        iconColor: 'info',
      },
      {
        key: 'roles',
        label: 'Roles',
        description: 'Custom roles with permission matrix',
        iconName: 'ShieldCheck',
        iconColor: 'teal',
      },
    ],
  },

  {
    key: 'store',
    title: 'Store Settings',
    description: 'Profile, hours, and taxes',
    iconName: 'Store',
    iconColor: 'neutral',
    items: [
      {
        key: 'store-details',
        label: 'Store Details',
        description: 'Address, logo, and contact info',
        iconName: 'Store',
        iconColor: 'neutral',
      },
      {
        key: 'store-hours',
        label: 'Store Hours',
        description: 'Opening hours and holiday schedules',
        iconName: 'Clock',
        iconColor: 'info',
      },
      {
        key: 'tax-rates',
        label: 'Tax Rates',
        description: 'GST slabs and custom rates',
        iconName: 'Calculator',
        iconColor: 'teal',
      },
      {
        key: 'payment-accounts',
        label: 'Payment Accounts',
        description: 'Cash, bank, UPI, card terminal, and wallet accounts',
        iconName: 'Wallet',
        iconColor: 'info',
      },
      {
        key: 'devices',
        label: 'Store Devices',
        description: 'Manage devices accessing this store',
        iconName: 'Smartphone',
        iconColor: 'teal',
      },
      {
        key: 'locations',
        label: 'Locations',
        description: 'Head Office and additional store locations',
        iconName: 'MapPin',
        iconColor: 'info',
      },
    ],
  },

  {
    key: 'subscription',
    title: 'Subscription',
    description: 'Plan, billing, and upgrades',
    iconName: 'Sparkles',
    iconColor: 'primary',
    route: '/(store)/subscription',
    items: [],
  },

  {
    key: 'system',
    title: 'System & Account',
    description: 'Preferences, sync, and workspace',
    iconName: 'Settings',
    iconColor: 'neutral',
    items: [
      {
        key: 'my-devices',
        label: 'My Devices',
        description: 'Manage your devices and block lost phones',
        iconName: 'Smartphone',
        iconColor: 'neutral',
      },
      {
        key: 'sessions',
        label: 'Sessions',
        description: 'See where you’re logged in and sign out remotely',
        iconName: 'Laptop',
        iconColor: 'neutral',
      },
      {
        key: 'settings',
        label: 'Settings',
        description: 'Theme, language, and preferences',
        iconName: 'Settings',
        iconColor: 'neutral',
      },
      {
        key: 'sync-issues',
        label: 'Sync Issues',
        description: 'Resolve conflicts and retry failures',
        iconName: 'TriangleAlert',
        iconColor: 'warning',
      },
    ],
  },

  {
    key: 'developer',
    title: 'Developer',
    description: 'Debug tools and local data',
    iconName: 'Database',
    iconColor: 'teal',
    items: [
      {
        key: 'local-tables',
        label: 'Local Tables',
        description: 'Browse SQLite tables and row counts',
        iconName: 'Database',
        iconColor: 'teal',
      },
    ],
  },
];
