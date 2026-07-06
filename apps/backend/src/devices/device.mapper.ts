import type { StoreDeviceRow } from './device-access.repository.js';
import type { MyDevice, SlotClaimResult } from './device-access.service.js';

/**
 * Slot-claim wire response (device-management §7 F2). The existing wire is
 * `{ access, isNew }` — `isNew` is camelCase and the mobile client already
 * depends on it, so the field names are preserved exactly and the mapper is a
 * pass-through. This exists purely to keep the service result type from leaking
 * to the controller return (layered-architecture §3.7).
 */
export interface SlotClaimResponse {
  access: 'granted';
  isNew:  boolean;
}

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
  /** Pass-through: wire field names (`access`, `isNew`) are unchanged. */
  toSlotClaimResponse(result: SlotClaimResult): SlotClaimResponse {
    return {
      access: result.access,
      isNew:  result.isNew,
    };
  },

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
