/**
 * Wire types for the devices domain. Field names mirror the backend DTO
 * (snake_case) exactly — see `apps/backend/src/devices/device.mapper.ts`.
 */

export interface MyDeviceResponse {
  device_id:    string;
  model:        string | null;
  platform:     string;
  os_version:   string | null;
  app_version:  string | null;
  trusted:      boolean;
  blocked:      boolean;
  last_seen_at: string;
  store_ids:    string[];
  is_current:   boolean;
}

export interface StoreDeviceResponse {
  device_id:        string;
  model:             string | null;
  platform:          string;
  user_name:         string;
  label:             string | null;
  status:            string;
  last_accessed_at:  string;
  registered_at:     string;
  revoked_reason:    string | null;
  is_current:        boolean;
}
