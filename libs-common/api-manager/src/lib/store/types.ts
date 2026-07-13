/**
 * Wire types for the store domain. Field names mirror the backend DTOs
 * (snake_case) exactly — see `apps/backend/src/stores/dto`.
 */
import type { PermissionSnapshot } from '../auth/types';

export interface CreateStoreRequest {
  name: string;
  gst_number?: string;
  address?: string;
  phone?: string;
  email?: string;
  /** F1 (docs/prd/accounts-and-ledger.md) — cash already in the drawer today,
   *  integer paise. Not yet collected by CreateStoreScreen's wizard; wired
   *  here so the API is ready when that field is added. */
  opening_cash_balance_paise?: number;
}

export interface CreateStoreResponse {
  id: string;
  name: string;
  snapshot: PermissionSnapshot | null;
  snapshot_signature: string | null;
}

export interface ClaimStoreAccessResponse {
  access: 'granted';
  isNew: boolean;
}

export interface StoreSetupStatusResponse {
  total_checks: number;
  completed_checks: number;
  completion_percentage: number;
  status_map: {
    store_profile_complete: boolean;
    staff_invited: boolean;
    product_added: boolean;
    payment_configured: boolean;
    device_linked: boolean;
  };
}
