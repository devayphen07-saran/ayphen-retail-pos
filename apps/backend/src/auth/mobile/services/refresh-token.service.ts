import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { randomBytes, randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DRIZZLE, type DbExecutor } from '../../../db/db.module.js';
import * as schema from '../../../db/schema.js';
import { devices } from '../../../db/schema.js';
import { CryptoService } from '../../core/crypto.service.js';
import { AuthConstantsService } from '../../core/auth-constants.service.js';
import { BlacklistCacheService } from './blacklist-cache.service.js';
import { DeviceChallengeService } from './device-challenge.service.js';
import { RefreshTokenRepository } from '../repositories/refresh-token.repository.js';
import { AuthSessionRepository } from '../repositories/auth-session.repository.js';
import { SessionCacheInvalidatorService } from './session-cache-invalidator.service.js';
import { RefreshIdempotencyService } from './refresh-idempotency.service.js';

export interface RotateInput {
  refreshToken:    string;
  challengeId?:   string;
  deviceSignature?: string;
  snapshotVersion?: number;
}

export interface RotateResult {
  accessToken:      string;
  refreshToken:     string;
  newJti:           string;
  newJtiExp:        Date;
  userId:           string;
  deviceSessionId:  string;
  snapshotVersion:  number;
}

@Injectable()
export class RefreshTokenService {
  constructor(
    @Inject(DRIZZLE)                   private readonly db:             PostgresJsDatabase<typeof schema>,
    private readonly crypto:           CryptoService,
    private readonly constants:        AuthConstantsService,
    private readonly blacklist:        BlacklistCacheService,
    private readonly challenge:        DeviceChallengeService,
    private readonly tokenRepo:        RefreshTokenRepository,
    private readonly sessionRepo:      AuthSessionRepository,
    private readonly cacheInvalidator: SessionCacheInvalidatorService,
    private readonly idempotency:      RefreshIdempotencyService,
  ) {}

  async issueRefreshToken(deviceSessionFk: string, tx?: DbExecutor): Promise<string> {
    const raw       = randomBytes(48).toString('hex');
    const tokenHash = this.crypto.hashToken(raw);
    const familyId  = randomUUID();
    const expiresAt = new Date(Date.now() + this.constants.REFRESH_TOKEN_TTL_SECONDS * 1000);

    await this.tokenRepo.insert({ deviceSessionFk, tokenHash, familyId, expiresAt }, tx);
    return raw;
  }

  /**
   * Idempotent entry point. Keyed on the incoming refresh token so that a
   * client retrying the same request (e.g. after a flaky network drop, before
   * the first response landed) gets the identical new token pair instead of
   * triggering a second rotation — which would mark the token used and trip
   * reuse-detection, nuking the whole family.
   */
  async rotate(dto: RotateInput): Promise<RotateResult> {
    const idemKey = this.crypto.hashToken(dto.refreshToken);

    const cached = await this.idempotency.claim(idemKey);
    if (cached) return this.reviveResult(cached);

    try {
      const result = await this.performRotation(dto);
      await this.idempotency.complete(idemKey, result);
      return result;
    } catch (err) {
      await this.idempotency.release(idemKey);
      throw err;
    }
  }

  /** Re-hydrate a cached RotateResult (Date fields survive JSON as strings). */
  private reviveResult(cached: unknown): RotateResult {
    const r = cached as RotateResult;
    return { ...r, newJtiExp: new Date(r.newJtiExp) };
  }

  private async performRotation(dto: RotateInput): Promise<RotateResult> {
    const tokenHash = this.crypto.hashToken(dto.refreshToken);
    const record    = await this.tokenRepo.findByHash(tokenHash);

    if (!record) throw new UnauthorizedException('REFRESH_TOKEN_REVOKED');

    const { session, user } = record;

    // 1. Reuse attack — token already consumed
    if (record.usedAt) {
      await this.tokenRepo.revokeFamily(record.familyId, 'reuse_detected');
      throw new UnauthorizedException('REFRESH_TOKEN_REUSE');
    }
    if (record.revokedAt) throw new UnauthorizedException('REFRESH_TOKEN_REVOKED');
    if (new Date() > record.expiresAt) throw new UnauthorizedException('REFRESH_TOKEN_EXPIRED');
    if (session.revokedAt) throw new UnauthorizedException('SESSION_REVOKED');
    if (new Date() > session.expiresAt) throw new UnauthorizedException('SESSION_EXPIRED');
    if (user.deletedAt) throw new UnauthorizedException('USER_NOT_FOUND');
    if (user.status !== 'active') throw new UnauthorizedException('USER_SUSPENDED');

    // 2. Device-binding proof. A refresh token is only as safe as the device it
    //    is bound to: if we accept it without proof of the device's private key,
    //    a stolen token alone rotates forever. So proof is MANDATORY unless the
    //    device has been explicitly trusted (is_trusted) — trust is the seam for
    //    relaxing this later; until a trust path sets it, every refresh must sign.
    const [device] = await this.db
      .select({ publicKey: devices.publicKey, isTrusted: devices.isTrusted })
      .from(devices)
      .where(eq(devices.id, session.deviceFk));
    if (!device) throw new UnauthorizedException('DEVICE_NOT_FOUND');

    if (!device.isTrusted) {
      if (!dto.challengeId || !dto.deviceSignature) {
        throw new UnauthorizedException('DEVICE_PROOF_REQUIRED');
      }

      await this.challenge.consumeChallenge(dto.challengeId);

      const ok = await this.crypto.verifyDeviceSignature(
        device.publicKey,
        dto.challengeId,
        dto.deviceSignature,
      );
      if (!ok) throw new UnauthorizedException('DEVICE_SIGNATURE_INVALID');
    }

    // 3. Atomic rotation
    const raw           = randomBytes(48).toString('hex');
    const newTokenHash  = this.crypto.hashToken(raw);
    const expiresAt     = new Date(Date.now() + this.constants.REFRESH_TOKEN_TTL_SECONDS * 1000);

    await this.tokenRepo.markUsed(record.id);
    await this.tokenRepo.insert({
      deviceSessionFk: session.id,
      tokenHash:       newTokenHash,
      parentId:        record.id,
      familyId:        record.familyId,
      expiresAt,
    });
    await this.sessionRepo.updateLastUsed(session.id);

    // 4. Blacklist old JWT
    if (session.currentJti && session.currentJtiExp) {
      await this.blacklist.addToBlacklist(session.currentJti, session.currentJtiExp);
    }

    // 5. Issue new JWT
    const accessToken = await this.crypto.signJwt(user.id, session.id, user.permissionsVersion);
    const newJtiExp   = new Date(Date.now() + this.constants.ACCESS_TOKEN_TTL_SECONDS * 1000);

    // Extract jti from new token (decode without verify — just payload)
    const parts  = accessToken.split('.');
    const claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString()) as { jti: string };

    await this.sessionRepo.updateCurrentJti(session.id, claims.jti, newJtiExp);
    await this.cacheInvalidator.invalidate(session.id);

    return {
      accessToken,
      refreshToken:    raw,
      newJti:          claims.jti,
      newJtiExp,
      userId:          user.id,
      deviceSessionId: session.id,
      snapshotVersion: user.permissionsVersion,
    };
  }
}
