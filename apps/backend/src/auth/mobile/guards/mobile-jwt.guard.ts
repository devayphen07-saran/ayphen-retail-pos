import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import Redis from 'ioredis';
import { eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { Inject } from '@nestjs/common';
import type { Request } from 'express';
import { DRIZZLE } from '#db/db.module.js';
import * as schema from '#db/schema.js';
import { deviceSessions, devices, users } from '#db/schema.js';
import { CryptoService } from '../../core/crypto.service.js';
import { BlacklistCacheService } from '../services/blacklist-cache.service.js';
import { ReplayProtectionService } from '../services/replay-protection.service.js';
import { UserRevocationCacheService } from '../../core/user-revocation-cache.service.js';
import { MOBILE_REDIS } from '../services/redis.provider.js';
import type { MobilePrincipal } from '../types/mobile-principal.js';

const SESSION_CACHE_TTL = 30; // seconds
const sessionKey = (id: string) => `session:${id}`;

@Injectable()
export class MobileJwtGuard implements CanActivate {
  constructor(
    private readonly crypto:      CryptoService,
    private readonly blacklist:   BlacklistCacheService,
    private readonly replay:      ReplayProtectionService,
    private readonly revocation:  UserRevocationCacheService,
    @Inject(MOBILE_REDIS) private readonly redis: Redis,
    @Inject(DRIZZLE)      private readonly db:    PostgresJsDatabase<typeof schema>,
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
      throw new UnauthorizedException('MISSING_TOKEN');
    const token = auth.slice(7);

    // ─ Step 2: Verify JWT + type:'access' (§18.3) ────────────────────────────
    const payload = await this.crypto.verifyJwt(token);
    if ((payload as { type?: string }).type !== 'access') {
      throw new UnauthorizedException('INVALID_TOKEN_TYPE');
    }

    const {
      sub: userId,
      jti,
      deviceSessionId,
      pv: jwtPv,
    } = payload as {
      sub: string;
      jti: string;
      deviceSessionId: string;
      pv?: number;
      exp: number;
    };
    const jtiExp = new Date((payload as { exp: number }).exp * 1000);

    // ─ Step 3: JTI blacklist (LRU → Redis → DB) ──────────────────────────────
    if (await this.blacklist.isBlacklisted(jti)) {
      throw new UnauthorizedException('TOKEN_REVOKED');
    }

    // ─ Step 4: Replay protection ──────────────────────────────────────────────
    // deviceId resolved after session load; replay check uses deviceId from session
    // We defer full replay check until after session is loaded (step 5)

    // ─ Step 5: Session load (Redis 30s cache → DB) ───────────────────────────
    const session = await this.loadSession(deviceSessionId);
    if (!session) throw new UnauthorizedException('SESSION_NOT_FOUND');
    if (session.revokedAt) throw new UnauthorizedException('SESSION_REVOKED');
    if (session.expiresAt < new Date())
      throw new UnauthorizedException('SESSION_EXPIRED');

    // ─ Step 4 (continued): Replay protection with real deviceId ──────────────
    await this.replay.check(
      session.deviceFk,
      req.headers['x-timestamp'] as string | undefined,
      req.headers['x-nonce'] as string | undefined,
    );

    // ─ Step 5b: Load device ───────────────────────────────────────────────────
    const [device] = await this.db
      .select()
      .from(devices)
      .where(eq(devices.id, session.deviceFk));
    if (!device) throw new UnauthorizedException('DEVICE_NOT_FOUND');
    if (device.isBlocked) throw new UnauthorizedException('DEVICE_BLOCKED');

    // ─ Step 6: User status block (§18.14) ────────────────────────────────────
    // Soft-delete check via 5s Redis cache — avoids a DB hit on every request.
    if (await this.revocation.isDeleted(userId))
      throw new UnauthorizedException('USER_NOT_FOUND');

    const [user] = await this.db
      .select()
      .from(users)
      .where(eq(users.id, userId));
    if (!user) throw new UnauthorizedException('USER_NOT_FOUND');
    if (user.isBlocked) throw new UnauthorizedException('USER_BLOCKED');
    if (user.status === 'suspended' || user.status === 'locked') {
      throw new UnauthorizedException('USER_SUSPENDED');
    }
    if (user.accountLockedUntil && user.accountLockedUntil > new Date()) {
      throw new UnauthorizedException('ACCOUNT_LOCKED');
    }
    if (!user.phoneVerified)
      throw new UnauthorizedException('PHONE_NOT_VERIFIED');

    // ─ Step 7: Attach MobilePrincipal ────────────────────────────────────────
    const principal: MobilePrincipal = {
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

    req.user = principal;

    // ─ Step 8: Wrap in requestContext ─────────────────────────────────────────
    // Guard runs synchronously; requestContext.run() is invoked by the interceptor
    // which wraps the handler. Here we just store the principal for the interceptor.
    // (requestContext.run is called in SnapshotRefreshInterceptor)

    return true;
  }

  private reviveSession(raw: string): typeof deviceSessions.$inferSelect {
    const row = JSON.parse(raw) as typeof deviceSessions.$inferSelect;
    const d = (v: unknown) => (v ? new Date(v as string) : null);
    row.expiresAt         = new Date(row.expiresAt);
    row.lastUsedAt        = new Date(row.lastUsedAt);
    row.createdAt         = new Date(row.createdAt);
    row.revokedAt         = d(row.revokedAt) as Date;
    row.lastStepUpAt      = d(row.lastStepUpAt) as Date;
    row.stepUpLockedUntil = d(row.stepUpLockedUntil) as Date;
    row.currentJtiExp     = d(row.currentJtiExp) as Date;
    return row;
  }

  private async loadSession(
    id: string,
  ): Promise<typeof deviceSessions.$inferSelect | null> {
    const cached = await this.redis.get(sessionKey(id));
    if (cached) return this.reviveSession(cached);

    const [row] = await this.db
      .select()
      .from(deviceSessions)
      .where(eq(deviceSessions.id, id));

    if (row) {
      await this.redis.setex(
        sessionKey(id),
        SESSION_CACHE_TTL,
        JSON.stringify(row),
      );
    }
    return row ?? null;
  }
}