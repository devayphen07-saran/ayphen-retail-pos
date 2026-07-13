import { Injectable, Logger } from '@nestjs/common';
import { UnitOfWork } from '#db/db.module.js';
import { unwrapPgError } from '#db/rethrow-unique-violation.js';
import { ForbiddenError, NotFoundError } from '#common/exceptions/app.exception.js';
import { ErrorCodes } from '#common/error-codes.js';
import { EntitlementService } from '../subscription/entitlement.service.js';
import { AuditService } from '#common/audit/audit.service.js';
import { BlacklistCacheService } from '#auth/mobile/services/blacklist-cache.service.js';
import { SessionCacheInvalidatorService } from '#auth/mobile/services/session-cache-invalidator.service.js';
import { DeviceAccessRepository, type StoreDeviceRow } from './device-access.repository.js';

export interface SlotClaimResult {
  access: 'granted';
  isNew:  boolean;
}

export interface MyDevice {
  id:        string;
  model:     string | null;
  platform:  string;
  osVersion: string | null;
  appVersion: string | null;
  isTrusted: boolean;
  isBlocked: boolean;
  lastSeenAt: Date;
  storeIds:  string[];
}

/**
 * Device slot lifecycle (device-management §7 F2, §10 F5, §13 F8, §14 F9, §12 F7).
 * The slot claim is atomic: the count check + insert run in a transaction, and
 * the partial unique index uk_sda_active is the concurrency backstop so two
 * devices can never share the last slot (BR-DEV-018).
 */
@Injectable()
export class DeviceAccessService {
  private readonly logger = new Logger(DeviceAccessService.name);

  constructor(
    private readonly repo: DeviceAccessRepository,
    private readonly entitlements: EntitlementService,
    private readonly audit: AuditService,
    private readonly uow: UnitOfWork,
    private readonly blacklist: BlacklistCacheService,
    private readonly cacheInvalidator: SessionCacheInvalidatorService,
  ) {}

  /**
   * Blacklist + drop the session cache for every revoked session so a
   * blocked/removed device's already-issued access token stops working
   * immediately, instead of surviving until its own natural expiry.
   *
   * Best-effort by design: the DB mutation (remove/block) has already
   * committed by the time this runs, so a Redis failure here must not
   * surface as a request failure — that would misreport an already-
   * successful removal/block as an error, and (worse, for `blockDevice`'s
   * stolen-device kill-switch) would leave the live token silently usable
   * with no retry/alert. Log and swallow instead.
   */
  private async revokeLiveTokens(
    context: string,
    sessions: { id: string; currentJti: string | null; currentJtiExp: Date | null }[],
  ): Promise<void> {
    // Independent, not sequential: these are two separate defense layers
    // (durable JTI blacklist + Redis session-cache invalidation) against the
    // same already-issued token. A transient failure in one must not skip
    // the other — a sequential await-then-await here would let a blacklist
    // DB hiccup silently prevent the cache invalidation from ever running,
    // leaving the stolen device's token live via the stale session cache for
    // up to its full TTL (backend-standard review finding).
    const toBlacklist = sessions
      .filter((s) => s.currentJti && s.currentJtiExp)
      .map((s) => ({ jti: s.currentJti!, exp: s.currentJtiExp! }));

    const [blacklistResult, cacheResult] = await Promise.allSettled([
      this.blacklist.addManyToBlacklist(toBlacklist),
      this.cacheInvalidator.invalidateMany(sessions.map((s) => s.id)),
    ]);

    if (blacklistResult.status === 'rejected') {
      this.logger.error(
        `${context}: failed to blacklist ${toBlacklist.length} JTI(s) post-commit — ` +
          `token(s) remain valid until natural expiry: ${blacklistResult.reason instanceof Error ? blacklistResult.reason.message : String(blacklistResult.reason)}`,
      );
    }
    if (cacheResult.status === 'rejected') {
      this.logger.error(
        `${context}: failed to invalidate ${sessions.length} session-cache entr(ies) post-commit — ` +
          `stale cache may still authenticate revoked session(s) until its TTL expires: ${cacheResult.reason instanceof Error ? cacheResult.reason.message : String(cacheResult.reason)}`,
      );
    }
  }

  /**
   * Claim (or refresh) this device's slot in a store. `accountId` resolves the
   * plan's max_devices_per_store. Returns granted or throws DEVICE_LIMIT_REACHED.
   */
  async claimSlot(
    storeId: string,
    accountId: string,
    deviceId: string,
    userId: string,
  ): Promise<SlotClaimResult> {
    // Already have an active slot → just heartbeat (idempotent re-claim, F2).
    const existing = await this.repo.findActiveSlot(storeId, deviceId);
    if (existing) {
      await this.repo.touchSlot(existing.id);
      return { access: 'granted', isNew: false };
    }

    try {
      return await this.uow.execute(async (tx) => {
        // Lock the store row so concurrent claims serialize, then recount
        // inside the txn (mirrors StoreService.createStore / InvitationService's
        // own account/store locks on the same class of plan-entitlement race).
        await this.repo.lockStore(storeId, tx);

        // Re-check for this exact device's own slot now that the store is
        // locked: the pre-lock `findActiveSlot` above can race against this
        // device's OWN concurrent retry (a dropped ack causing a client
        // resend) — both requests see "no slot yet", the loser then blocks
        // on the lock, and without this re-check it would recount, see its
        // own winner-request's row already occupying the last slot, and
        // reject its own device with DEVICE_LIMIT_REACHED. A device re-
        // claiming its own existing slot is idempotent and must never be
        // limit-gated.
        const raced = await this.repo.findActiveSlot(storeId, deviceId, tx);
        if (raced) {
          await this.repo.touchSlot(raced.id, tx);
          return { access: 'granted' as const, isNew: false };
        }

        // Recount inside the txn; null limit = unlimited (Enterprise). The
        // limit itself is also fetched inside the lock, not just the count:
        // an entitlement change (e.g. a plan downgrade reconciling
        // concurrently) between a pre-lock fetch and this recount would
        // otherwise validate the fresh count against a stale limit.
        const limit = await this.entitlements.get(accountId, 'max_devices_per_store', tx);
        const active = await this.repo.countActiveSlots(storeId, tx);
        if (!this.entitlements.canCreate(limit, active)) {
          // F3 needs the slot-holder list (sorted by last_accessed_at) so the
          // owner can see who's using a slot without a second round trip.
          // Active-only, filtered in SQL (not fetch-all-then-filter-in-JS) —
          // this runs while holding lockStore's row lock, so the query must
          // stay bounded to the plan-capped active count, not the store's
          // full (ever-growing, never-purged) device history.
          const holders = await this.repo.listActiveStoreDevices(storeId, tx);
          throw new ForbiddenError(
            ErrorCodes.DEVICE_LIMIT_REACHED,
            'Device limit reached for this store',
            {
              limit,
              active,
              devices: holders.map((d) => ({
                deviceId:       d.deviceFk,
                model:          d.model,
                platform:       d.platform,
                userName:       d.userName,
                deviceLabel:    d.deviceLabel,
                lastAccessedAt: d.lastAccessedAt,
              })),
            },
          );
        }
        await this.repo.insertSlot({ storeFk: storeId, deviceFk: deviceId, userFk: userId }, tx);
        return { access: 'granted' as const, isNew: true };
      });
    } catch (err) {
      // Lost the race for the last slot: another request inserted the same
      // (store, device) active row. Treat as a successful idempotent re-claim.
      if (unwrapPgError(err)?.code === '23505') {
        return { access: 'granted', isNew: false };
      }
      throw err;
    }
  }

  /** Owner removes a device from a store (F5). Cannot remove your own current device. */
  async removeDevice(
    storeId: string,
    actorId: string,
    currentDeviceId: string,
    targetDeviceId: string,
  ): Promise<void> {
    if (targetDeviceId === currentDeviceId) {
      throw new ForbiddenError(
        ErrorCodes.CANNOT_REMOVE_CURRENT_DEVICE,
        'You cannot remove the device you are currently using',
      ); // self-lockout, BR-DEV-005
    }
    const { slotRevoked, sessions } = await this.uow.execute(async (tx) => {
      const n = await this.repo.revokeSlot(storeId, targetDeviceId, actorId, 'owner_removed', tx);
      const sessions = n > 0
        ? await this.repo.revokeDeviceSessions(targetDeviceId, 'store_device_removed', tx)
        : [];
      if (n > 0) {
        await this.audit.logInTransaction({
          event: 'DEVICE_REMOVED', activityType: 'DEVICE_BLOCKED',
          prefix: 'Device', suffix: 'removed from store',
          userId: actorId, storeFk: storeId, isSuccess: true,
          entityType: 'Device', entityId: targetDeviceId,
        }, tx);
      }
      return { slotRevoked: n, sessions };
    });
    if (!slotRevoked) throw new NotFoundError(ErrorCodes.DEVICE_SLOT_NOT_FOUND, 'Device slot not found');

    // Best-effort, post-commit — same reasoning as auth-logout.service.ts:
    // failure here shouldn't roll back a successful removal.
    await this.revokeLiveTokens(`removeDevice(${targetDeviceId})`, sessions);
  }

  async listStoreDevices(storeId: string): Promise<StoreDeviceRow[]> {
    return this.repo.listStoreDevices(storeId);
  }

  /** Block a stolen/lost device — global kill across all stores (F8). Owner of the device only. */
  async blockDevice(userId: string, targetDeviceId: string): Promise<void> {
    const device = await this.repo.findOwnedDevice(targetDeviceId, userId);
    if (!device) throw new NotFoundError(ErrorCodes.DEVICE_NOT_FOUND, 'Device not found');

    const sessions = await this.uow.execute(async (tx) => {
      await this.repo.setBlocked(targetDeviceId, true, tx);
      const sessions = await this.repo.revokeDeviceSessions(targetDeviceId, 'device_blocked_stolen', tx);
      await this.repo.revokeAllSlotsForDevice(targetDeviceId, userId, 'stolen', tx);
      await this.audit.logInTransaction({
        event: 'DEVICE_BLOCKED', activityType: 'DEVICE_BLOCKED',
        prefix: 'Device', suffix: 'blocked (stolen/lost)',
        userId, isSuccess: true, entityType: 'Device', entityId: targetDeviceId,
      }, tx);
      return sessions;
    });

    // Post-commit: kill the device's already-issued access token(s) now,
    // instead of leaving them valid until natural expiry (the whole point of
    // "block a stolen device" is that it stops working immediately).
    await this.revokeLiveTokens(`blockDevice(${targetDeviceId})`, sessions);
  }

  /** Unblock a recovered device (F9). Slots/sessions stay revoked — device is "fresh". */
  async unblockDevice(userId: string, targetDeviceId: string): Promise<void> {
    const device = await this.repo.findOwnedDevice(targetDeviceId, userId);
    if (!device) throw new NotFoundError(ErrorCodes.DEVICE_NOT_FOUND, 'Device not found');
    await this.repo.setBlocked(targetDeviceId, false);
    // Single-statement write, no transaction to commit the audit row with —
    // best-effort only, must never fail an already-applied unblock.
    try {
      await this.audit.log({
        event: 'DEVICE_UNBLOCKED', activityType: 'DEVICE_BLOCKED',
        prefix: 'Device', suffix: 'unblocked',
        userId, isSuccess: true, entityType: 'Device', entityId: targetDeviceId,
      });
    } catch {
      /* best-effort audit — the unblock already committed */
    }
  }

  /** My Devices — all devices for the user, with the stores each currently accesses (F7). */
  async listMyDevices(userId: string): Promise<MyDevice[]> {
    const devices = await this.repo.listUserDevices(userId);
    const storesByDevice = await this.repo.activeStoresForDevices(devices.map((d) => d.id));
    return devices.map((d) => ({
      id:         d.id,
      model:      d.model,
      platform:   d.platform,
      osVersion:  d.osVersion,
      appVersion: d.appVersion,
      isTrusted:  d.isTrusted,
      isBlocked:  d.isBlocked,
      lastSeenAt: d.lastSeenAt,
      storeIds:   storesByDevice.get(d.id) ?? [],
    }));
  }
}
