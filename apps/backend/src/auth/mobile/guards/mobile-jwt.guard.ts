import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { Inject } from '@nestjs/common';
import type { Request } from 'express';
import { DRIZZLE } from '#db/db.module.js';
import * as schema from '#db/schema.js';
import { deviceSessions } from '#db/schema.js';
import { CryptoService } from '../../core/crypto.service.js';
import { BlacklistCacheService } from '../services/blacklist-cache.service.js';
import { ReplayProtectionService } from '../services/replay-protection.service.js';
import { SessionCacheInvalidatorService } from '../services/session-cache-invalidator.service.js';
import {
  PrincipalCacheService,
  type CachedDevice,
  type CachedUser,
} from '../services/principal-cache.service.js';
import type { MobilePrincipal } from '#common/types/principal.js';
import { ErrorCodes } from '#common/error-codes.js';

@Injectable()
export class MobileJwtGuard implements CanActivate {
  private readonly logger = new Logger(MobileJwtGuard.name);

  constructor(
    private readonly crypto:      CryptoService,
    private readonly blacklist:   BlacklistCacheService,
    private readonly replay:      ReplayProtectionService,
    private readonly principals:  PrincipalCacheService,
    private readonly sessionCache: SessionCacheInvalidatorService,
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>,
  ) {}

  canActivate(
    context: ExecutionContext,
  ): boolean | Promise<boolean> | Observable<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    return this.authenticate(req);
  }

  private async authenticate(req: Request): Promise<boolean> {
    // ─ Step 1: Extract Bearer token ──────────────────────────────────────────
    const auth = req.headers['authorization'] ?? '';
    if (!auth.startsWith('Bearer '))
      throw new UnauthorizedException(ErrorCodes.MISSING_TOKEN);
    const token = auth.slice(7);

    // ─ Step 2: Verify JWT + type:'access' (§18.3) ────────────────────────────
    // verifyJwt validates the claim shape (Zod), so the fields below are typed —
    // no casts. `type` is kept loose there so we own the INVALID_TOKEN_TYPE code.
    const payload = await this.crypto.verifyJwt(token);
    if (payload.type !== 'access') {
      throw new UnauthorizedException(ErrorCodes.INVALID_TOKEN_TYPE);
    }

    const { sub: userId, jti, deviceSessionId, pv: jwtPv } = payload;
    const jtiExp = new Date(payload.exp * 1000);

    // ─ Step 3: JTI blacklist (LRU → Redis → DB) ──────────────────────────────
    if (await this.blacklist.isBlacklisted(jti)) {
      throw new UnauthorizedException(ErrorCodes.TOKEN_REVOKED);
    }

    // ─ Steps 4-5: Session load (Redis 30s cache → DB) + replay protection ────
    const session = await this.resolveSession(deviceSessionId, jti, req);

    // ─ Steps 5b-6: Device + user status checks ───────────────────────────────
    const { device, user } = await this.assertUserEligible(session.deviceFk, userId);

    // ─ Step 7: Attach MobilePrincipal ────────────────────────────────────────
    req.user = this.buildPrincipal(user, device, session, jti, jtiExp, jwtPv);

    // ─ Step 8: Wrap in requestContext ─────────────────────────────────────────
    // Guard runs synchronously; requestContext.run() is invoked by the interceptor
    // which wraps the handler. Here we just store the principal for the interceptor.
    // (requestContext.run is called in SnapshotRefreshInterceptor)

    return true;
  }

  /**
   * Steps 4-5 — load the session (Redis 30s cache → DB), validate it, and run
   * replay protection now that the session's real deviceFk is known.
   */
  private async resolveSession(
    deviceSessionId: string,
    jti: string,
    req: Request,
  ): Promise<typeof deviceSessions.$inferSelect> {
    const session = await this.loadSession(deviceSessionId);
    if (!session) throw new UnauthorizedException(ErrorCodes.SESSION_NOT_FOUND);
    if (session.revokedAt) throw new UnauthorizedException(ErrorCodes.SESSION_REVOKED);
    if (session.expiresAt < new Date())
      throw new UnauthorizedException(ErrorCodes.SESSION_EXPIRED);
    // Fallback defense alongside the blacklist: a session's currentJti is
    // stamped by every refresh rotation, so a token whose jti doesn't match it
    // has been superseded. This catches a superseded token even if the
    // rotation's best-effort blacklist write failed — currentJti is null until
    // the first rotation, so an initial post-login token is unaffected.
    if (session.currentJti && session.currentJti !== jti) {
      throw new UnauthorizedException({
        message: "You've been signed in on another device. Please log in again.",
        errorCode: ErrorCodes.SESSION_REPLACED,
      });
    }

    await this.replay.check(
      session.deviceFk,
      req.headers['x-timestamp'] as string | undefined,
      req.headers['x-nonce'] as string | undefined,
    );

    return session;
  }

  /**
   * Steps 5b-6 — device block-status (Redis-cached projection → DB) and user
   * account-status checks (§18.14, Redis-cached → DB).
   */
  private async assertUserEligible(
    deviceId: string,
    userId: string,
  ): Promise<{ device: CachedDevice; user: CachedUser }> {
    const device = await this.principals.getDevice(deviceId);
    if (!device) throw new UnauthorizedException(ErrorCodes.DEVICE_NOT_FOUND);
    if (device.isBlocked) throw new UnauthorizedException(ErrorCodes.DEVICE_BLOCKED);

    const user = await this.principals.getUser(userId);
    if (!user) throw new UnauthorizedException(ErrorCodes.USER_NOT_FOUND);
    // Soft-delete check on the cached projection — replaces the redundant 5s
    // revocation cache.
    if (user.deletedAt) throw new UnauthorizedException(ErrorCodes.USER_NOT_FOUND);
    if (user.isBlocked) throw new UnauthorizedException(ErrorCodes.USER_BLOCKED);
    if (user.status === 'suspended' || user.status === 'locked') {
      throw new UnauthorizedException(ErrorCodes.USER_SUSPENDED);
    }
    if (user.accountLockedUntil && new Date(user.accountLockedUntil) > new Date()) {
      throw new UnauthorizedException(ErrorCodes.ACCOUNT_LOCKED);
    }
    if (!user.phoneVerified)
      throw new UnauthorizedException(ErrorCodes.PHONE_NOT_VERIFIED);

    return { device, user };
  }

  /** Step 7 — pure construction of the request principal. */
  private buildPrincipal(
    user: CachedUser,
    device: CachedDevice,
    session: typeof deviceSessions.$inferSelect,
    jti: string,
    jtiExp: Date,
    jwtPv: number,
  ): MobilePrincipal {
    return {
      userId: user.id,
      userGuuid: user.guuid,
      deviceSessionId: session.id,
      deviceId: device.id,
      devicePlatform: device.platform ?? 'unknown',
      permissionsVersion: user.permissionsVersion,
      jwtPv: jwtPv ?? user.permissionsVersion,   // fallback for tokens issued pre-pv
      stepUpAt: session.lastStepUpAt ?? undefined,
      stepUpMethod: session.lastStepUpMethod ?? undefined,
      currentJti: jti,
      currentJtiExp: jtiExp,
    };
  }

  private async loadSession(
    id: string,
  ): Promise<typeof deviceSessions.$inferSelect | null> {
    // Degrade to DB on a Redis ERROR (not a miss) OR a corrupt/mismatched
    // cached payload (SessionCacheInvalidatorService.read validates the
    // shape and returns null rather than trusting a blind cast): the session
    // row lives durably in `deviceSessions`, so both must fall through to it
    // — NOT return null, which would read as "no session" and log every
    // user out. Only a real cache miss (null) proceeds to DB too; all three
    // paths converge below.
    try {
      const cached = await this.sessionCache.read(id);
      if (cached) return cached;
    } catch (err) {
      this.logger.warn(
        `Session cache read failed for ${id}; falling back to DB: ${
          err instanceof Error ? err.message : 'unknown Redis error'
        }`,
      );
    }

    const [row] = await this.db
      .select()
      .from(deviceSessions)
      .where(eq(deviceSessions.id, id));

    if (row) {
      // fillIfNotTombstoned is itself best-effort — see SessionCacheInvalidatorService.
      await this.sessionCache.fillIfNotTombstoned(id, row);
    }
    return row ?? null;
  }
}