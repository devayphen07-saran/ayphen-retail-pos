import { Injectable, Logger } from '@nestjs/common';
import { AppException } from '#common/exceptions/app.exception.js';
import { ErrorCodes } from '#common/error-codes.js';
import { UnitOfWork } from '#db/db.module.js';
import { AuditService } from '#common/audit/audit.service.js';
import { DeviceAccessRepository } from '../../../devices/device-access.repository.js';
import { AuthSessionRepository } from '../repositories/auth-session.repository.js';
import { RefreshTokenRepository } from '../repositories/refresh-token.repository.js';
import { BlacklistCacheService } from './blacklist-cache.service.js';
import { SessionCacheInvalidatorService } from './session-cache-invalidator.service.js';
import type { CursorPage } from '#common/pagination/paginate.js';
import type { SessionWithDevice } from '../repositories/auth-session.repository.js';

@Injectable()
export class AuthLogoutService {
  private readonly logger = new Logger(AuthLogoutService.name);

  constructor(
    private readonly sessionRepo:      AuthSessionRepository,
    private readonly refreshTokenRepo: RefreshTokenRepository,
    private readonly deviceAccess:     DeviceAccessRepository,
    private readonly blacklist:        BlacklistCacheService,
    private readonly cacheInvalidator: SessionCacheInvalidatorService,
    private readonly audit:            AuditService,
    private readonly uow:              UnitOfWork,
  ) {}

  /**
   * Log out the current session — blacklist its JWT, revoke it + its refresh
   * tokens, drop its cache, and release every store slot this device was
   * holding (device-management: a logged-out device isn't actively using a
   * store anymore, so it shouldn't keep occupying a plan-limited slot until
   * the 30-day auto-expiry cron eventually catches it). Re-opening a store on
   * this device after a fresh login is a normal, idempotent slot re-claim.
   */
  async logout(userId: string, deviceSessionId: string, deviceId: string, currentJti: string, jtiExp: Date): Promise<void> {
    // Blacklist insert + session/refresh-token revocation commit together or
    // not at all — previously the blacklist write ran before this transaction,
    // so a crash between the two could blacklist the JWT while leaving the
    // session (and its refresh token) live.
    await this.uow.execute(async (tx) => {
      await this.blacklist.addToBlacklist(currentJti, jtiExp, tx);
      await this.sessionRepo.revokeSession(deviceSessionId, 'user_logout', tx);
      await this.refreshTokenRepo.revokeBySession(deviceSessionId, 'user_logout', tx);
      await this.deviceAccess.revokeAllSlotsForDevice(deviceId, userId, 'released', tx);
      await this.audit.logInTransaction({
        event: 'LOGOUT', activityType: 'AUTH_LOGOUT',
        prefix: 'User', suffix: 'logged out',
        userId,
      }, tx);
    });
    await this.shieldedInvalidate(
      () => this.cacheInvalidator.invalidate(deviceSessionId),
      `logout(${deviceSessionId})`,
    );
  }

  /** Log out every active session for the user, blacklisting each active JWT. */
  async logoutAll(userId: string): Promise<void> {
    const sessions = await this.sessionRepo.listActiveSessionsWithJti(userId);
    const toBlacklist = sessions
      .filter((s) => s.currentJti && s.currentJtiExp)
      .map((s) => ({ jti: s.currentJti!, exp: s.currentJtiExp! }));
    // Distinct devices behind these sessions — a device can hold more than one
    // active session, so slots must be released once per device, not once per
    // session (see logout()'s doc comment for why a slot release belongs here).
    const deviceIds = [...new Set(sessions.map((s) => s.deviceFk))];

    // Blacklist inserts + all sessions + all their refresh tokens revoked as
    // one atomic unit (same reasoning as logout() above).
    await this.uow.execute(async (tx) => {
      await this.blacklist.addManyToBlacklist(toBlacklist, tx);
      await this.refreshTokenRepo.revokeByManySessions(
        sessions.map((s) => s.id),
        'user_logout_all',
        tx,
      );
      await this.sessionRepo.revokeAllUserSessions(userId, 'user_logout_all', tx);
      for (const deviceId of deviceIds) {
        await this.deviceAccess.revokeAllSlotsForDevice(deviceId, userId, 'released', tx);
      }
      // Audit the global logout — it's more consequential than a single-session
      // logout (which is already audited), so it must leave a trail too.
      await this.audit.logInTransaction({
        event: 'LOGOUT_ALL', activityType: 'AUTH_LOGOUT',
        prefix: 'User', suffix: `logged out of all sessions (${sessions.length})`,
        userId,
      }, tx);
    });
    await this.shieldedInvalidate(
      () => this.cacheInvalidator.invalidateAllForUser(userId),
      `logoutAll(${userId})`,
    );
  }

  /** Cursor-paginated list of a user's active sessions. */
  async listSessions(
    userId: string,
    page: { limit: number; cursor?: string },
  ): Promise<CursorPage<SessionWithDevice>> {
    return this.sessionRepo.listActiveSessions(userId, page);
  }

  /**
   * Revoke a specific session owned by userId. This is the same kill-a-session
   * action as logout() and MUST use identical machinery: blacklisting the target
   * session's JWT + dropping its cache is what makes revocation *immediate*.
   * Without it, revoking a stolen device from a trusted one would still leave the
   * compromised device usable until the session-cache TTL and access-JWT both lapse.
   * Throws NOT_FOUND if the session doesn't exist or belongs to another user.
   */
  async revokeSession(sessionId: string, userId: string): Promise<void> {
    const target = await this.sessionRepo.findActiveByIdForUser(sessionId, userId);
    if (!target) {
      throw new AppException(ErrorCodes.NOT_FOUND, 'Session not found', 404);
    }
    await this.uow.execute(async (tx) => {
      if (target.currentJti && target.currentJtiExp) {
        await this.blacklist.addToBlacklist(target.currentJti, target.currentJtiExp, tx);
      }
      await this.sessionRepo.revokeSession(sessionId, 'user_revoked', tx);
      await this.refreshTokenRepo.revokeBySession(sessionId, 'user_revoked', tx);
      // Release the target device's store slot too — this is the "revoke a
      // stolen device" remediation path, so it must free the slot the same
      // way DeviceAccessService.blockDevice() does, not just kill the session.
      await this.deviceAccess.revokeAllSlotsForDevice(target.deviceFk, userId, 'stolen', tx);
      await this.audit.logInTransaction({
        event: 'SESSION_REVOKED', activityType: 'AUTH_LOGOUT',
        prefix: 'User', suffix: 'revoked a session',
        userId,
      }, tx);
    });
    await this.shieldedInvalidate(
      () => this.cacheInvalidator.invalidate(sessionId),
      `revokeSession(${sessionId})`,
    );
  }

  /**
   * The blacklist write above is durable — committed in the same transaction
   * as the revocation — so a cache-invalidation failure here is redundant
   * with, not a substitute for, that guarantee. Shielded so a transient
   * Redis blip turns into a stale cache entry (self-heals on its own TTL),
   * not a 500 on an already-successful logout/revoke (backend-standard
   * review finding — this was previously unguarded, inconsistent with
   * DeviceAccessService's best-effort wrapping for the equivalent call).
   */
  private async shieldedInvalidate(invalidate: () => Promise<void>, context: string): Promise<void> {
    try {
      await invalidate();
    } catch (err) {
      this.logger.error(
        `${context}: session-cache invalidation failed post-commit — stale cache entry ` +
          `will self-heal on its own TTL: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
