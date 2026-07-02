import type { StoreDeviceRow } from './device-access.repository.js';
import type { MyDevice } from './device-access.service.js';

export interface StoreDeviceResponse {
  device_id:        string;
  model:            string | null;
  platform:         string;
  user_name:        string;
  label:            string | null;
  status:           string;
  last_accessed_at: string;
  registered_at:    string;
  revoked_reason:   string | null;
  is_current:       boolean;
}

export interface MyDeviceResponse {
  device_id:   string;
  model:       string | null;
  platform:    string;
  os_version:  string | null;
  app_version: string | null;
  trusted:     boolean;
  blocked:     boolean;
  last_seen_at: string;
  store_ids:   string[];
  is_current:  boolean;
}

/** Pure domain → snake_case mappers (layered-architecture §3.7). */
export const StoreDeviceMapper = {
  toStoreDeviceList(rows: StoreDeviceRow[], currentDeviceId: string): StoreDeviceResponse[] {
    return rows.map((r) => ({
      device_id:        r.deviceFk,
      model:            r.model,
      platform:         r.platform,
      user_name:        r.userName,
      label:            r.deviceLabel,
      status:           r.status,
      last_accessed_at: r.lastAccessedAt.toISOString(),
      registered_at:    r.firstAccessedAt.toISOString(),
      revoked_reason:   r.revokedReason,
      is_current:       r.deviceFk === currentDeviceId,
    }));
  },

  toMyDeviceList(devices: MyDevice[], currentDeviceId: string): MyDeviceResponse[] {
    return devices.map((d) => ({
      device_id:   d.id,
      model:       d.model,
      platform:    d.platform,
      os_version:  d.osVersion,
      app_version: d.appVersion,
      trusted:     d.isTrusted,
      blocked:     d.isBlocked,
      last_seen_at: d.lastSeenAt.toISOString(),
      store_ids:   d.storeIds,
      is_current:  d.id === currentDeviceId,
    }));
  },
};
