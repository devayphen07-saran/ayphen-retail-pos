/**
 * Wire types for the locations domain. Field names mirror the backend DTO
 * (snake_case) exactly — see `apps/backend/src/locations/location.mapper.ts`.
 */

export interface LocationResponse {
  id:            string;
  name:          string;
  is_primary:    boolean; // Head Office
  is_default:    boolean;
  enable:        boolean;
  is_locked:     boolean; // downgrade-locked
  display_order: number;
}

export interface CreateLocationRequest {
  name:        string;
  is_default?: boolean;
}

export interface UpdateLocationRequest {
  name?:   string;
  enable?: boolean;
}