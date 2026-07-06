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
import { AppConfigService } from '#config/app-config.service.js';
import { BlacklistCacheService } from '../services/blacklist-cache.service.js';
import { ReplayProtectionService } from '../services/replay-protection.service.js';
import { MOBILE_REDIS } from '../services/redis.provider.js';
import type { MobilePrincipal } from '../types/mobile-principal.js';

const sessionKey = (id: string) => `session:${id}`;

@Injectable()
export class MobileJwtGuard implements CanActivate {
  constructor(
    private readonly crypto:      CryptoService,
    private readonly config:      AppConfigService,
    private readonly blacklist:   BlacklistCacheService,
    private readonly replay:      ReplayProtectionService,
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
    // verifyJwt validates the claim shape (Zod), so the fields below are typed —
    // no casts. `type` is kept loose there so we own the INVALID_TOKEN_TYPE code.
    const payload = await this.crypto.verifyJwt(token);
    if (payload.type !== 'access') {
      throw new UnauthorizedException('INVALID_TOKEN_TYPE');
    }

    const { sub: userId, jti, deviceSessionId, pv: jwtPv } = payload;
    const jtiExp = new Date(payload.exp * 1000);

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
    const [user] = await this.db
      .select()
      .from(users)
      .where(eq(users.id, userId));
    if (!user) throw new UnauthorizedException('USER_NOT_FOUND');
    // Soft-delete check on the already-loaded row — replaces the redundant 5s
    // revocation cache (the full user row is fetched every request anyway).
    if (user.deletedAt) throw new UnauthorizedException('USER_NOT_FOUND');
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
    // JSON turns Dates into ISO strings; rehydrate them. Nullable columns stay
    // null (the row type is honest about `Date | null`, so no assertion needed).
    const nullableDate = (v: Date | null): Date | null => (v ? new Date(v) : null);
    row.expiresAt         = new Date(row.expiresAt);
    row.lastUsedAt        = new Date(row.lastUsedAt);
    row.createdAt         = new Date(row.createdAt);
    row.revokedAt         = nullableDate(row.revokedAt);
    row.lastStepUpAt      = nullableDate(row.lastStepUpAt);
    row.stepUpLockedUntil = nullableDate(row.stepUpLockedUntil);
    row.currentJtiExp     = nullableDate(row.currentJtiExp);
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
        this.config.sessionCacheTtlSeconds,
        JSON.stringify(row),
      );
    }
    return row ?? null;
  }
}