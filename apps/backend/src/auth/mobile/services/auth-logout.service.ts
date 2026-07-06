import { Injectable } from '@nestjs/common';
import { AppException } from '#common/exceptions/app.exception.js';
import { ErrorCodes } from '#common/error-codes.js';
import { UnitOfWork } from '#db/db.module.js';
import { AuditService } from '#common/audit/audit.service.js';
import { AuthSessionRepository } from '../repositories/auth-session.repository.js';
import { RefreshTokenRepository } from '../repositories/refresh-token.repository.js';
import { BlacklistCacheService } from './blacklist-cache.service.js';
import { SessionCacheInvalidatorService } from './session-cache-invalidator.service.js';
import type { CursorPage } from '#common/pagination/paginate.js';
import type { SessionWithDevice } from '../repositories/auth-session.repository.js';

@Injectable()
export class AuthLogoutService {
  constructor(
    private readonly sessionRepo:      AuthSessionRepository,
    private readonly refreshTokenRepo: RefreshTokenRepository,
    private readonly blacklist:        BlacklistCacheService,
    private readonly cacheInvalidator: SessionCacheInvalidatorService,
    private readonly audit:            AuditService,
    private readonly uow:              UnitOfWork,
  ) {}

  /** Log out the current session — blacklist its JWT, revoke it + its refresh tokens, drop its cache. */
  async logout(userId: string, deviceSessionId: string, currentJti: string, jtiExp: Date): Promise<void> {
    await this.blacklist.addToBlacklist(currentJti, jtiExp);
    // Session + refresh-token revocation commit together or not at all —
    // previously two separate un-transactioned writes.
    await this.uow.execute(async (tx) => {
      await this.sessionRepo.revokeSession(deviceSessionId, 'user_logout', tx);
      await this.refreshTokenRepo.revokeBySession(deviceSessionId, 'user_logout', tx);
    });
    await this.cacheInvalidator.invalidate(deviceSessionId);
    await this.audit.log({
      event: 'LOGOUT', activityType: 'AUTH_LOGOUT',
      prefix: 'User', suffix: 'logged out',
      userId,
    });
  }

  /** Log out every active session for the user, blacklisting each active JWT. */
  async logoutAll(userId: string): Promise<void> {
    const sessions = await this.sessionRepo.getActiveSessionsWithJti(userId);
    for (const s of sessions) {
      if (s.currentJti && s.currentJtiExp) {
        await this.blacklist.addToBlacklist(s.currentJti, s.currentJtiExp);
      }
    }
    // All sessions + all their refresh tokens revoked as one atomic unit.
    await this.uow.execute(async (tx) => {
      for (const s of sessions) {
        await this.refreshTokenRepo.revokeBySession(s.id, 'user_logout_all', tx);
      }
      await this.sessionRepo.revokeAllUserSessions(userId, 'user_logout_all', tx);
    });
    await this.cacheInvalidator.invalidateAllForUser(userId);
    // Audit the global logout — it's more consequential than a single-session
    // logout (which is already audited), so it must leave a trail too.
    await this.audit.log({
      event: 'LOGOUT_ALL', activityType: 'AUTH_LOGOUT',
      prefix: 'User', suffix: `logged out of all sessions (${sessions.length})`,
      userId,
    });
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
    if (target.currentJti && target.currentJtiExp) {
      await this.blacklist.addToBlacklist(target.currentJti, target.currentJtiExp);
    }
    await this.uow.execute(async (tx) => {
      await this.sessionRepo.revokeSession(sessionId, 'user_revoked', tx);
      await this.refreshTokenRepo.revokeBySession(sessionId, 'user_revoked', tx);
    });
    await this.cacheInvalidator.invalidate(sessionId);
    await this.audit.log({
      event: 'SESSION_REVOKED', activityType: 'AUTH_LOGOUT',
      prefix: 'User', suffix: 'revoked a session',
      userId,
    });
  }
}
