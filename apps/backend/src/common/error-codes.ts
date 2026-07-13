/**
 * The single source of truth for machine-readable error codes.
 *
 * Every `AppException` carries one of these. Guards may still throw a bare
 * SCREAMING_SNAKE code as a message (the `AllExceptionsFilter` promotes it to
 * `errorCode`), but that code MUST exist here so the wire contract stays
 * centralized and kept in sync with the mobile client (PRD §20.2).
 */
export const ErrorCodes = {
  // ── Auth: tokens & sessions ────────────────────────────────────────────
  INVALID_CREDENTIALS:                'INVALID_CREDENTIALS',
  MISSING_TOKEN:                      'MISSING_TOKEN',
  TOKEN_EXPIRED:                      'TOKEN_EXPIRED',
  TOKEN_INVALID:                      'TOKEN_INVALID',
  TOKEN_REVOKED:                      'TOKEN_REVOKED',
  INVALID_TOKEN_TYPE:                 'INVALID_TOKEN_TYPE',
  REFRESH_TOKEN_REVOKED:              'REFRESH_TOKEN_REVOKED',
  REFRESH_TOKEN_EXPIRED:              'REFRESH_TOKEN_EXPIRED',
  REFRESH_TOKEN_REUSE:                'REFRESH_TOKEN_REUSE',
  REFRESH_IN_PROGRESS_RETRY:          'REFRESH_IN_PROGRESS_RETRY',
  SESSION_NOT_FOUND:                  'SESSION_NOT_FOUND',
  SESSION_REVOKED:                    'SESSION_REVOKED',
  SESSION_EXPIRED:                    'SESSION_EXPIRED',
  SESSION_REPLACED:                   'SESSION_REPLACED',
  ACCOUNT_LOCKED:                     'ACCOUNT_LOCKED',
  REPLAY_DETECTED:                    'REPLAY_DETECTED',
  MISSING_AUTH:                       'MISSING_AUTH',

  // ── Auth: OTP & step-up ────────────────────────────────────────────────
  OTP_EXPIRED:                        'OTP_EXPIRED',
  OTP_INVALID:                        'OTP_INVALID',
  OTP_MAX_ATTEMPTS:                   'OTP_MAX_ATTEMPTS',
  OTP_SEND_FAILED:                    'OTP_SEND_FAILED',
  STEP_UP_REQUIRED:                   'STEP_UP_REQUIRED',
  STEP_UP_AUTH_REQUIRED:              'STEP_UP_AUTH_REQUIRED',
  STEP_UP_LOCKED:                     'STEP_UP_LOCKED',
  PHONE_NOT_VERIFIED:                 'PHONE_NOT_VERIFIED',

  // ── Auth: device proof ─────────────────────────────────────────────────
  CHALLENGE_NOT_FOUND:                'CHALLENGE_NOT_FOUND',
  DEVICE_PROOF_REQUIRED:              'DEVICE_PROOF_REQUIRED',
  DEVICE_SIGNATURE_INVALID:           'DEVICE_SIGNATURE_INVALID',

  // ── Users ──────────────────────────────────────────────────────────────
  USER_NOT_FOUND:                     'USER_NOT_FOUND',
  USER_BLOCKED:                       'USER_BLOCKED',
  USER_SUSPENDED:                     'USER_SUSPENDED',
  USER_LOCKED:                        'USER_LOCKED',
  USER_ALREADY_EXISTS:                'USER_ALREADY_EXISTS',
  USER_NOT_STORE_MEMBER:              'USER_NOT_STORE_MEMBER',

  // ── Devices ────────────────────────────────────────────────────────────
  DEVICE_NOT_FOUND:                   'DEVICE_NOT_FOUND',
  DEVICE_BLOCKED:                     'DEVICE_BLOCKED',
  DEVICE_REVOKED:                     'DEVICE_REVOKED',
  DEVICE_SLOT_NOT_FOUND:              'DEVICE_SLOT_NOT_FOUND',
  DEVICE_SLOT_REQUIRED:               'DEVICE_SLOT_REQUIRED',
  CANNOT_REMOVE_CURRENT_DEVICE:       'CANNOT_REMOVE_CURRENT_DEVICE',
  DEVICE_LIMIT_REACHED:               'DEVICE_LIMIT_REACHED',
  OVER_DEVICE_LIMIT:                  'OVER_DEVICE_LIMIT',
  UNKNOWN_DEVICE:                     'UNKNOWN_DEVICE',

  // ── Stores / tenant isolation ──────────────────────────────────────────
  STORE_NOT_FOUND:                    'STORE_NOT_FOUND',
  STORE_NOT_ACCESSIBLE:               'STORE_NOT_ACCESSIBLE',
  STORE_ACCESS_DENIED:                'STORE_ACCESS_DENIED',
  STORE_CONTEXT_MISSING:              'STORE_CONTEXT_MISSING',
  STORE_LOCKED:                       'STORE_LOCKED',
  STORE_LIMIT_REACHED:                'STORE_LIMIT_REACHED',
  OVER_STORE_LIMIT:                   'OVER_STORE_LIMIT',
  NOT_ACCOUNT_OWNER:                  'NOT_ACCOUNT_OWNER',

  // ── Roles & permissions ────────────────────────────────────────────────
  PERMISSION_DENIED:                  'PERMISSION_DENIED',
  SPECIAL_PERMISSION_DENIED:          'SPECIAL_PERMISSION_DENIED',
  ONLINE_REQUIRED:                    'ONLINE_REQUIRED',
  ROLE_NOT_FOUND:                     'ROLE_NOT_FOUND',
  ROLE_ALREADY_EXISTS:                'ROLE_ALREADY_EXISTS',
  ROLE_NOT_EDITABLE:                  'ROLE_NOT_EDITABLE',
  ROLE_NOT_ASSIGNABLE:                'ROLE_NOT_ASSIGNABLE',
  ROLE_NOT_REVOCABLE:                 'ROLE_NOT_REVOCABLE',
  ROLE_HAS_ACTIVE_ASSIGNMENTS:        'ROLE_HAS_ACTIVE_ASSIGNMENTS',
  ROLE_HAS_PENDING_INVITATIONS:       'ROLE_HAS_PENDING_INVITATIONS',
  ROLE_RESERVED_CODE:                 'ROLE_RESERVED_CODE',
  ROLE_VERSION_CONFLICT:              'ROLE_VERSION_CONFLICT',
  ASSIGNMENT_ALREADY_EXISTS:          'ASSIGNMENT_ALREADY_EXISTS',
  ASSIGNMENT_NOT_FOUND:               'ASSIGNMENT_NOT_FOUND',
  INVALID_ENTITY_CODE:                'INVALID_ENTITY_CODE',
  GRANT_EXCEEDS_ACTOR_PERMISSIONS:    'GRANT_EXCEEDS_ACTOR_PERMISSIONS',

  // ── Tax rates ──────────────────────────────────────────────────────────
  TAXRATE_NOT_FOUND:                  'TAXRATE_NOT_FOUND',
  TAXRATE_ALREADY_EXISTS:             'TAXRATE_ALREADY_EXISTS',
  TAXRATE_VERSION_CONFLICT:           'TAXRATE_VERSION_CONFLICT',

  // ── Invitations ────────────────────────────────────────────────────────
  INVITATION_NOT_FOUND:               'INVITATION_NOT_FOUND',
  INVITATION_ALREADY_PENDING:         'INVITATION_ALREADY_PENDING',
  INVITATION_NOT_PENDING:             'INVITATION_NOT_PENDING',
  INVITATION_EXPIRED:                 'INVITATION_EXPIRED',
  INVITATION_CONTACT_REQUIRED:        'INVITATION_CONTACT_REQUIRED',

  // ── Subscription & billing ─────────────────────────────────────────────
  SUBSCRIPTION_NOT_FOUND:               'SUBSCRIPTION_NOT_FOUND',
  SUBSCRIPTION_NOT_ACTIVE:              'SUBSCRIPTION_NOT_ACTIVE',
  SUBSCRIPTION_SUSPENDED:               'SUBSCRIPTION_SUSPENDED',
  SUBSCRIPTION_PAYMENT_REQUIRED:        'SUBSCRIPTION_PAYMENT_REQUIRED',
  SUBSCRIPTION_RECONCILIATION_REQUIRED: 'SUBSCRIPTION_RECONCILIATION_REQUIRED',
  SUBSCRIPTION_LAPSED_USE_CHECKOUT:     'SUBSCRIPTION_LAPSED_USE_CHECKOUT',
  SUBSCRIPTION_LAPSED_AT_WRITE:         'SUBSCRIPTION_LAPSED_AT_WRITE',
  PLAN_NOT_CONFIGURED:                  'PLAN_NOT_CONFIGURED',
  UNKNOWN_PLAN_CODE:                    'UNKNOWN_PLAN_CODE',
  PAYMENT_ORDER_NOT_FOUND:              'PAYMENT_ORDER_NOT_FOUND',
  PAYMENT_PROVIDER_UNAVAILABLE:         'PAYMENT_PROVIDER_UNAVAILABLE',
  PAYMENT_SIGNATURE_INVALID:            'PAYMENT_SIGNATURE_INVALID',
  PAYMENT_AMOUNT_MISMATCH:              'PAYMENT_AMOUNT_MISMATCH',
  WEBHOOK_SIGNATURE_INVALID:            'WEBHOOK_SIGNATURE_INVALID',
  RECONCILIATION_INVALID:               'RECONCILIATION_INVALID',
  ACTIVATE_STORE_NOT_LOCKED:            'ACTIVATE_STORE_NOT_LOCKED',
  DEACTIVATE_STORE_NOT_ACTIVE:          'DEACTIVATE_STORE_NOT_ACTIVE',

  // ── Products ───────────────────────────────────────────────────────────
  PRODUCT_NOT_FOUND:                  'PRODUCT_NOT_FOUND',
  PRODUCT_SKU_EXISTS:                 'PRODUCT_SKU_EXISTS',
  PRODUCT_INACTIVE:                   'PRODUCT_INACTIVE',
  PRODUCT_LIMIT_REACHED:              'PRODUCT_LIMIT_REACHED',
  INSUFFICIENT_STOCK:                 'INSUFFICIENT_STOCK',

  // ── Orders ─────────────────────────────────────────────────────────────
  ORDER_NOT_FOUND:                    'ORDER_NOT_FOUND',
  ORDER_ALREADY_PAID:                 'ORDER_ALREADY_PAID',
  ORDER_ALREADY_CANCELLED:            'ORDER_ALREADY_CANCELLED',
  INVALID_ORDER_TRANSITION:           'INVALID_ORDER_TRANSITION',
  EMPTY_ORDER:                        'EMPTY_ORDER',
  CONCURRENT_MODIFICATION:            'CONCURRENT_MODIFICATION',
  MISSING_IDEMPOTENCY_KEY:            'MISSING_IDEMPOTENCY_KEY',
  DUPLICATE_IDEMPOTENCY_KEY:          'DUPLICATE_IDEMPOTENCY_KEY',

  // ── Lookups ────────────────────────────────────────────────────────────
  INVALID_LOOKUP_CODE:                'INVALID_LOOKUP_CODE',
  LOOKUP_TYPE_NOT_FOUND:              'LOOKUP_TYPE_NOT_FOUND',
  LOOKUP_VALUE_NOT_FOUND:             'LOOKUP_VALUE_NOT_FOUND',
  LOOKUP_CODE_EXISTS:                 'LOOKUP_CODE_EXISTS',
  LOOKUP_VALUE_PROTECTED:             'LOOKUP_VALUE_PROTECTED',
  LOOKUP_VALUE_VERSION_CONFLICT:      'LOOKUP_VALUE_VERSION_CONFLICT',
  // Seeded Cash/Bank payment accounts (is_system) cannot be deleted or
  // deactivated (PRD payment-accounts-mobile §BR-4).
  PAYMENT_ACCOUNT_PROTECTED:          'PAYMENT_ACCOUNT_PROTECTED',
  ENTITY_TYPE_NOT_FOUND:              'ENTITY_TYPE_NOT_FOUND',

  // ── Ledger (docs/prd/accounts-and-ledger.md) ───────────────────────────
  ACCOUNT_INACTIVE:                   'ACCOUNT_INACTIVE',
  // Server always recomputes sale.total_paise from lines (BR-1) — the client
  // never sends one, so there is no "mismatch" case to report there. What CAN
  // mismatch is the payments against that computed total:
  PAYMENT_MISMATCH:                   'PAYMENT_MISMATCH',
  SALE_NOT_FOUND:                     'SALE_NOT_FOUND',
  SALE_LINE_NOT_FOUND:                'SALE_LINE_NOT_FOUND',
  REFUND_EXCEEDS_SALE:                'REFUND_EXCEEDS_SALE',

  // ── Sync engine (sync-engine.md) ───────────────────────────────────────
  SYNC_HORIZON_EXCEEDED:              'SYNC_HORIZON_EXCEEDED',
  UPGRADE_REQUIRED:                   'UPGRADE_REQUIRED',
  SYNC_MISSING_ROW_VERSION:           'SYNC_MISSING_ROW_VERSION',
  UNKNOWN_MUTATION:                   'UNKNOWN_MUTATION',
  PARENT_FAILED:                      'PARENT_FAILED',
  PARENT_CYCLE:                       'PARENT_CYCLE',
  SHIFT_NOT_OPEN:                     'SHIFT_NOT_OPEN',
  MUTATION_PAYLOAD_TOO_LARGE:         'MUTATION_PAYLOAD_TOO_LARGE',
  SYNC_CONFLICT_NOT_FOUND:            'SYNC_CONFLICT_NOT_FOUND',
  SERVER_ERROR:                       'SERVER_ERROR',

  // ── Files & uploads (table-architecture §33) ───────────────────────────
  FILE_NOT_FOUND:                     'FILE_NOT_FOUND',
  TEMP_FILE_NOT_FOUND:                'TEMP_FILE_NOT_FOUND',
  TEMP_FILE_EXPIRED:                  'TEMP_FILE_EXPIRED',
  FILE_TYPE_NOT_ALLOWED:              'FILE_TYPE_NOT_ALLOWED',
  FILE_TOO_LARGE:                     'FILE_TOO_LARGE',
  FILE_CONSOLIDATED_SIZE_EXCEEDED:    'FILE_CONSOLIDATED_SIZE_EXCEEDED',
  FILE_ATTACHMENT_LIMIT_EXCEEDED:     'FILE_ATTACHMENT_LIMIT_EXCEEDED',
  FILE_CONTENT_MISMATCH:              'FILE_CONTENT_MISMATCH',
  FILE_EMPTY:                         'FILE_EMPTY',
  FILE_CONFIG_NOT_FOUND:              'FILE_CONFIG_NOT_FOUND',
  ENTITY_DOES_NOT_SUPPORT_ATTACHMENTS:'ENTITY_DOES_NOT_SUPPORT_ATTACHMENTS',
  STORAGE_UNAVAILABLE:                'STORAGE_UNAVAILABLE',
  FILE_PARENT_NOT_FOUND:              'FILE_PARENT_NOT_FOUND',
  FILE_PARENT_VERIFICATION_UNAVAILABLE:'FILE_PARENT_VERIFICATION_UNAVAILABLE',

  // ── General ────────────────────────────────────────────────────────────
  NOT_FOUND:                          'NOT_FOUND',
  CONFLICT:                           'CONFLICT',
  VALIDATION_FAILED:                  'VALIDATION_FAILED',
  PASSWORD_TOO_LONG:                  'PASSWORD_TOO_LONG',
  DUPLICATE_ENTRY:                    'DUPLICATE_ENTRY',
  FOREIGN_KEY_VIOLATION:              'FOREIGN_KEY_VIOLATION',
  FORBIDDEN:                          'FORBIDDEN',
  UNAUTHORIZED:                       'UNAUTHORIZED',
  RATE_LIMIT_EXCEEDED:                'RATE_LIMIT_EXCEEDED',
  INVALID_CURSOR:                     'INVALID_CURSOR',
  REQUEST_TIMEOUT:                    'REQUEST_TIMEOUT',
  SERVICE_UNAVAILABLE:                'SERVICE_UNAVAILABLE',
  TRANSIENT_CONFLICT:                 'TRANSIENT_CONFLICT',
  INTERNAL_ERROR:                     'INTERNAL_ERROR',
} as const;

export type ErrorCode = typeof ErrorCodes[keyof typeof ErrorCodes];
