import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE, type Database } from '#db/db.module.js';
import { devices } from '#db/schema.js';

/**
 * Stamps `devices.last_sync_at` on EVERY sync touch — cold start, delta pull,
 * and mutation push alike (F1). S-34's oversell detection evaluates events only
 * up to `T = min(last_sync_at across the store's active devices)`, so a device
 * that merely *pulls* (a display/kitchen screen, or any counter between sales)
 * must still advance the watermark — otherwise it pegs the `min` forever and
 * stalls oversell detection store-wide.
 *
 * Best-effort by design: a failed stamp leaves `last_sync_at` stale, which only
 * makes the oversell gate MORE conservative (it evaluates older events) — never
 * wrong. So the stamp must never break a sync response; it is caught and logged.
 */
@Injectable()
export class DeviceSyncHealthRepository {
  private readonly logger = new Logger(DeviceSyncHealthRepository.name);

  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async touch(deviceId: string, at: Date): Promise<void> {
    try {
      await this.db.update(devices).set({ lastSyncAt: at }).where(eq(devices.id, deviceId));
    } catch (error) {
      this.logger.warn(`failed to stamp devices.last_sync_at for ${deviceId}: ${String(error)}`);
    }
  }

  /**
   * This device's last server-observed sync (C1). Read at preflight, BEFORE the
   * per-request `touch()` in buildResult stamps the new value, so it reflects
   * the device's PRIOR contact. The subscription write-gate floors its check at
   * this instant: a device demonstrably online after a lapse can't then submit
   * writes stamped before the lapse, while genuine offline sales (always stamped
   * after the last sync) are unaffected. Returns null if never synced.
   */
  async getLastSyncAt(deviceId: string): Promise<Date | null> {
    const [row] = await this.db
      .select({ lastSyncAt: devices.lastSyncAt })
      .from(devices)
      .where(eq(devices.id, deviceId))
      .limit(1);
    return row?.lastSyncAt ?? null;
  }
}
