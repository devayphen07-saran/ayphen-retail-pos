/**
 * Wire types for the store domain. Field names mirror the backend DTOs
 * (snake_case) exactly — see `apps/backend/src/stores/dto`.
 */

export interface CreateStoreRequest {
  name: string;
  gst_number?: string;
  address?: string;
  phone?: string;
  email?: string;
}

export interface CreateStoreResponse {
  id: string;
  name: string;
}

export interface ClaimStoreAccessResponse {
  access: 'granted';
  isNew: boolean;
}
