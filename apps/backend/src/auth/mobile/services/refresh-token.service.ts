import { Injectable, Logger } from '@nestjs/common';
import { randomBytes, randomUUID } from 'crypto';
import { z } from 'zod';
import {
  ServiceUnavailableError,
  UnauthorizedError,
} from '#common/exceptions/app.exception.js';
import { ErrorCodes } from '#common/error-codes.js';
import { UnitOfWork, type DbExecutor } from '#db/db.module.js';
import { CryptoService } from '../../core/crypto.service.js';
import { BlacklistCacheService } from './blacklist-cache.service.js';
import { DeviceChallengeService } from './device-challenge.service.js';
import {
  DeviceRepository,
  type Device,
} from '../repositories/device.repository.js';
import {
  RefreshTokenRepository,
  type RefreshTokenWithSession,
} from '../repositories/refresh-token.repository.js';
import { AuthSessionRepository } from '../repositories/auth-session.repository.js';
import { SessionCacheInvalidatorService } from './session-cache-invalidator.service.js';
import {
  RefreshIdempotencyService,
  REFRESH_IDEM_DONE_TTL_SECONDS,
} from './refresh-idempotency.service.js';
import { SnapshotService } from './snapshot.service.js';
import type { SnapshotResult } from '../types/permission-snapshot.js';
import { AppConfigService } from '#config/app-config.service.js';

/**
 * Reuse-grace window (flow-critic Phase 3): a token whose usedAt is younger
 * than this was consumed by a CONCURRENT rotation (a client timeout-retry
 * racing its own original request while the Redis idempotency layer was
 * unavailable), not by a replayed stolen token. Within the window the loser
 * gets the retryable REFRESH_IN_PROGRESS_RETRY signal instead of a family
 * revocation — critically, the winner's just-issued successor token survives.
 * Only a token used longer ago than this is treated as a genuine reuse attack.
 */
const REUSE_GRACE_MS = 30_000;

/**
 * A used token may still legitimately need to complete a refresh: a client
 * that crashed after the server committed the rotation but before persisting
 * the new pair retries with the OLD token, and recovers via the idempotency
 * DONE record. That path still starts at the challenge endpoint, so
 * challenges must remain issuable for this long after usedAt — gated by the
 * same device proof as everything else.
 */
const CACHED_RECOVERY_WINDOW_MS = REFRESH_IDEM_DONE_TTL_SECONDS * 1000;

export interface RotateInput {
  refreshToken: string;
  challengeId?: string;
  deviceSignature?: string;
  snapshotVersion?: number;
}

export interface RotateResult {
  accessToken: string;
  refreshToken: string;
  newJti: string;
  newJtiExp: Date;
  userId: string;
  deviceSessionId: string;
  snapshotVersion: number;
  /** null when the client's snapshotVersion is already current (getOrBuild
   *  returns null) — mirrors the "snapshot_changed" contract. */
  snapshotResult: SnapshotResult | null;
}

@Injectable()
export class RefreshTokenService {
  private readonly logger = new Logger(RefreshTokenService.name);

  constructor(
    private readonly deviceRepo: DeviceRepository,
    private readonly crypto: CryptoService,
    private readonly config: AppConfigService,
    private readonly blacklist: BlacklistCacheService,
    private readonly challenge: DeviceChallengeService,
    private readonly tokenRepo: RefreshTokenRepository,
    private readonly sessionRepo: AuthSessionRepository,
    private readonly cacheInvalidator: SessionCacheInvalidatorService,
    private readonly idempotency: RefreshIdempotencyService,
    private readonly snapshot: SnapshotService,
    private readonly uow: UnitOfWork,
  ) {}

  async issueRefreshToken(
    deviceSessionFk: string,
    tx?: DbExecutor,
  ): Promise<string> {
    const raw = randomBytes(48).toString('hex');
    const tokenHash = this.crypto.hashToken(raw);
    const familyId = randomUUID();
    const expiresAt = new Date(
      Date.now() + this.config.refreshTokenTtlSeconds * 1000,
    );

    await this.tokenRepo.insert(
      { deviceSessionFk, tokenHash, familyId, expiresAt },
      tx,
    );
    return raw;
  }

  /**
   * Issue a device-binding challenge for a refresh, keyed off the refresh token
   * itself (NOT an access token — at refresh time the access token is expired,
   * so this path must be reachable without one). Resolves the device that the
   * token is bound to and issues a challenge tied to that device; the client
   * signs it with the device private key and echoes it back to `rotate()`.
   *
   * Validates the token enough to refuse issuing challenges for garbage/expired
   * tokens, but deliberately does NOT consume or rotate it — that only happens
   * in `rotate()` once the signature checks out.
   */
  async issueRefreshChallenge(refreshToken: string): Promise<string> {
    const tokenHash = this.crypto.hashToken(refreshToken);
    const record = await this.tokenRepo.findByHash(tokenHash);

    if (!record)
      throw new UnauthorizedError(
        ErrorCodes.REFRESH_TOKEN_REVOKED,
        'Refresh token is not recognized',
      );
    // A recently-used token may be a crashed client recovering its committed
    // rotation via the idempotency DONE record — that flow still needs a
    // challenge (rotate()'s cached path verifies device proof against it), so
    // keep issuing challenges inside the recovery window. Beyond it the DONE
    // record is gone and this can only be a replay.
    if (
      record.usedAt &&
      Date.now() - record.usedAt.getTime() > CACHED_RECOVERY_WINDOW_MS
    ) {
      throw new UnauthorizedError(
        ErrorCodes.REFRESH_TOKEN_REUSE,
        'Refresh token has already been used',
      );
    }
    if (record.revokedAt)
      throw new UnauthorizedError(
        ErrorCodes.REFRESH_TOKEN_REVOKED,
        'Refresh token has been revoked',
      );
    if (new Date() > record.expiresAt)
      throw new UnauthorizedError(
        ErrorCodes.REFRESH_TOKEN_EXPIRED,
        'Refresh token has expired',
      );
    if (record.session.revokedAt)
      throw new UnauthorizedError(
        ErrorCodes.SESSION_REVOKED,
        'Session has been revoked',
      );
    if (new Date() > record.session.expiresAt)
      throw new UnauthorizedError(
        ErrorCodes.SESSION_EXPIRED,
        'Session has expired',
      );

    return this.challenge.issueChallenge(record.session.deviceFk);
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

    const claim = await this.idempotency.claim(idemKey);
    if (claim.role === 'cached') {
      // The cached path skips performRotation() — but its payload is a live
      // token pair, so it must be gated by the SAME device-binding proof as a
      // real rotation. Without this, anyone who captured the old refresh
      // token could harvest the successor pair from cache for the whole
      // DONE-record lifetime without ever proving device possession.
      const result = this.reviveResult(claim.response);
      await this.verifyDeviceProofForCached(result.deviceSessionId, dto);
      return result;
    }
    if (claim.role === 'timed_out') {
      // The leader (another concurrent call for the same token) is still
      // mid-rotation — do NOT proceed to performRotation() ourselves: the
      // loser of that race would hit the `markUsed` CAS below, get treated as
      // REFRESH_TOKEN_REUSE, and revoke the whole token family over nothing
      // more than DB latency (flow-critic review, Finding A). Surface a
      // distinct, retryable signal instead of a false reuse-detection trip.
      throw new ServiceUnavailableError(
        ErrorCodes.REFRESH_IN_PROGRESS_RETRY,
        'A concurrent refresh is in progress; please retry',
      );
    }

    try {
      const result = await this.performRotation(dto);
      await this.idempotency.complete(idemKey, result);
      return result;
    } catch (err) {
      await this.idempotency.release(idemKey);
      throw err;
    }
  }

  /**
   * Device-binding proof for the cached idempotency path — mirrors
   * performRotation() step 2, resolved via the cached result's session (the
   * original token row is already consumed, so the proof anchors to the
   * session's bound device instead).
   */
  private async verifyDeviceProofForCached(
    deviceSessionId: string,
    dto: RotateInput,
  ): Promise<void> {
    const session = await this.sessionRepo.findById(deviceSessionId);
    if (!session)
      throw new UnauthorizedError(
        ErrorCodes.SESSION_REVOKED,
        'Session no longer exists',
      );
    if (session.revokedAt)
      throw new UnauthorizedError(
        ErrorCodes.SESSION_REVOKED,
        'Session has been revoked',
      );

    const device = await this.deviceRepo.findById(session.deviceFk);
    if (!device)
      throw new UnauthorizedError(
        ErrorCodes.DEVICE_NOT_FOUND,
        'Bound device not found',
      );

    await this.assertDeviceProof(device, session.deviceFk, dto);
  }

  /**
   * The device-binding proof core shared by performRotation() step 2 and
   * verifyDeviceProofForCached() — a stolen refresh token alone must never be
   * enough to rotate; proof is mandatory unless the device is explicitly
   * trusted (is_trusted). `boundDeviceId` is checked separately from `device`
   * itself so a challenge minted for device A can't be replayed to prove
   * device B.
   */
  private async assertDeviceProof(
    device: Device,
    boundDeviceId: string,
    dto: RotateInput,
  ): Promise<void> {
    if (device.isTrusted) return;

    if (!dto.challengeId || !dto.deviceSignature) {
      throw new UnauthorizedError(
        ErrorCodes.DEVICE_PROOF_REQUIRED,
        'Device proof is required for this refresh',
      );
    }

    const challengeDeviceId = await this.challenge.consumeChallenge(
      dto.challengeId,
    );
    if (challengeDeviceId !== boundDeviceId) {
      throw new UnauthorizedError(
        ErrorCodes.DEVICE_SIGNATURE_INVALID,
        'Device signature does not match the bound device',
      );
    }

    const ok = await this.crypto.verifyDeviceSignature(
      device.publicKey,
      dto.challengeId,
      dto.deviceSignature,
    );
    if (!ok)
      throw new UnauthorizedError(
        ErrorCodes.DEVICE_SIGNATURE_INVALID,
        'Device signature verification failed',
      );
  }

  /**
   * Re-hydrate a cached RotateResult (our own idempotency payload). Validating
   * the envelope with Zod — and coercing `newJtiExp` back to a Date — beats a
   * blind `as RotateResult`: a shape drift is caught here, not at a later
   * `.getTime()`. `snapshotResult` is stored/returned verbatim (JSON-safe).
   */
  private reviveResult(cached: unknown): RotateResult {
    const parsed = RefreshTokenService.CachedRotateSchema.parse(cached);
    return {
      accessToken: parsed.accessToken,
      refreshToken: parsed.refreshToken,
      newJti: parsed.newJti,
      newJtiExp: parsed.newJtiExp,
      userId: parsed.userId,
      deviceSessionId: parsed.deviceSessionId,
      snapshotVersion: parsed.snapshotVersion,
      snapshotResult: parsed.snapshotResult as SnapshotResult | null,
    };
  }

  private static readonly CachedRotateSchema = z.object({
    accessToken: z.string(),
    refreshToken: z.string(),
    newJti: z.string(),
    newJtiExp: z.coerce.date(),
    userId: z.string(),
    deviceSessionId: z.string(),
    snapshotVersion: z.number(),
    snapshotResult: z.unknown(),
  });

  private async performRotation(dto: RotateInput): Promise<RotateResult> {
    const tokenHash = this.crypto.hashToken(dto.refreshToken);
    const record = await this.tokenRepo.findByHash(tokenHash);
    if (!record)
      throw new UnauthorizedError(
        ErrorCodes.REFRESH_TOKEN_REVOKED,
        'Refresh token is not recognized',
      );

    const { session, user } = record;

    // 1. Token/session/user must all still be usable.
    await this.assertTokenUsable(record);

    // 2. Device-binding proof. A refresh token is only as safe as the device it
    //    is bound to: if we accept it without proof of the device's private key,
    //    a stolen token alone rotates forever. So proof is MANDATORY unless the
    //    device has been explicitly trusted (is_trusted) — trust is the seam for
    //    relaxing this later; until a trust path sets it, every refresh must sign.
    const device = await this.deviceRepo.findById(session.deviceFk);
    if (!device)
      throw new UnauthorizedError(
        ErrorCodes.DEVICE_NOT_FOUND,
        'Bound device not found',
      );
    await this.assertDeviceProof(device, session.deviceFk, dto);

    // 3. Issue the new JWT up front — signing is pure crypto (no DB), and the
    //    resulting jti must be persisted alongside the rotated token below.
    const accessToken = await this.crypto.signJwt(
      user.id,
      session.id,
      user.permissionsVersion,
    );
    const newJtiExp = new Date(
      Date.now() + this.config.accessTokenTtlSeconds * 1000,
    );

    // Extract jti from new token (decode without verify — just payload)
    const parts = accessToken.split('.');
    const claims = JSON.parse(
      Buffer.from(parts[1]!, 'base64url').toString(),
    ) as { jti: string };

    // 4. Atomic rotation — commits or throws.
    const refreshToken = await this.commitRotation(
      record,
      session,
      claims.jti,
      newJtiExp,
    );

    // 5. Post-commit best-effort side effects (blacklist, cache, snapshot).
    const snapshotResult = await this.emitBestEffortSideEffects(
      session,
      user,
      dto,
    );

    return {
      accessToken,
      refreshToken,
      newJti: claims.jti,
      newJtiExp,
      userId: user.id,
      deviceSessionId: session.id,
      snapshotVersion: user.permissionsVersion,
      snapshotResult,
    };
  }

  /**
   * Step 1 — token already consumed. Within the grace window this is a
   * concurrent rotation whose DONE record Redis lost (leader committed
   * moments ago) — retryable, and revoking the family here would kill the
   * winner's just-issued successor. Beyond the grace it's a reuse attack.
   */
  private async assertTokenUsable(
    record: RefreshTokenWithSession,
  ): Promise<void> {
    const { session, user } = record;

    if (record.usedAt) {
      if (Date.now() - record.usedAt.getTime() < REUSE_GRACE_MS) {
        throw new ServiceUnavailableError(
          ErrorCodes.REFRESH_IN_PROGRESS_RETRY,
          'A concurrent refresh is in progress; please retry',
        );
      }
      await this.tokenRepo.revokeFamily(record.familyId, 'reuse_detected');
      throw new UnauthorizedError(
        ErrorCodes.REFRESH_TOKEN_REUSE,
        'Refresh token has already been used',
      );
    }
    if (record.revokedAt)
      throw new UnauthorizedError(
        ErrorCodes.REFRESH_TOKEN_REVOKED,
        'Refresh token has been revoked',
      );
    if (new Date() > record.expiresAt)
      throw new UnauthorizedError(
        ErrorCodes.REFRESH_TOKEN_EXPIRED,
        'Refresh token has expired',
      );
    if (session.revokedAt)
      throw new UnauthorizedError(
        ErrorCodes.SESSION_REVOKED,
        'Session has been revoked',
      );
    if (new Date() > session.expiresAt)
      throw new UnauthorizedError(
        ErrorCodes.SESSION_EXPIRED,
        'Session has expired',
      );
    if (user.deletedAt)
      throw new UnauthorizedError(
        ErrorCodes.USER_NOT_FOUND,
        'User account no longer exists',
      );
    if (user.status !== 'active')
      throw new UnauthorizedError(
        ErrorCodes.USER_SUSPENDED,
        'User account is suspended',
      );
  }

  /**
   * Step 4 — atomic rotation. All writes commit together or roll back
   * together, so a crash mid-rotation can never leave a family without a
   * successor.
   *
   * The `record.usedAt` check in assertTokenUsable() reads outside this
   * transaction, so two concurrent rotations of the same token can both pass
   * it before either commits. `markUsed` is the actual compare-and-swap:
   * whoever's UPDATE lands first wins the row: the loser must be treated as a
   * reuse attempt, not a second successful rotation, or the family forks. On
   * loss the revocation still needs to commit, so we return a sentinel and
   * throw *after* the transaction rather than inside it — throwing inside
   * would roll back the very revokeFamily write we need to persist.
   */
  private async commitRotation(
    record: RefreshTokenWithSession,
    session: RefreshTokenWithSession['session'],
    newJti: string,
    newJtiExp: Date,
  ): Promise<string> {
    const raw = randomBytes(48).toString('hex');
    const newTokenHash = this.crypto.hashToken(raw);
    const expiresAt = new Date(
      Date.now() + this.config.refreshTokenTtlSeconds * 1000,
    );

    const raceResult = await this.uow.execute(
      async (tx): Promise<'won' | 'lost_recent' | 'lost'> => {
        const wonRace = await this.tokenRepo.markUsed(record.id, tx);
        if (!wonRace) {
          // Same grace as assertTokenUsable(): a usedAt stamped seconds ago is
          // our own concurrent duplicate (client timeout-retry with the
          // idempotency layer down), and revoking the family would kill the
          // winner's fresh successor — the very token the client is about to
          // receive.
          const usedAt = await this.tokenRepo.findUsedAt(record.id, tx);
          const isRecent =
            usedAt !== null && Date.now() - usedAt.getTime() < REUSE_GRACE_MS;
          if (isRecent) return 'lost_recent';
          await this.tokenRepo.revokeFamily(
            record.familyId,
            'reuse_detected',
            tx,
          );
          return 'lost';
        }
        await this.tokenRepo.insert(
          {
            deviceSessionFk: session.id,
            tokenHash: newTokenHash,
            parentId: record.id,
            familyId: record.familyId,
            expiresAt,
          },
          tx,
        );
        await this.sessionRepo.updateLastUsed(session.id, tx);
        await this.sessionRepo.updateCurrentJti(
          session.id,
          newJti,
          newJtiExp,
          tx,
        );
        return 'won';
      },
    );

    if (raceResult === 'lost_recent') {
      throw new ServiceUnavailableError(
        ErrorCodes.REFRESH_IN_PROGRESS_RETRY,
        'A concurrent refresh is in progress; please retry',
      );
    }
    if (raceResult === 'lost') {
      throw new UnauthorizedError(
        ErrorCodes.REFRESH_TOKEN_REUSE,
        'Refresh token has already been used',
      );
    }
    return raw;
  }

  /**
   * Step 5 — post-commit: blacklist the old JWT, invalidate caches, and
   * refresh the permission snapshot. Best-effort side effects — never part
   * of the DB transaction, and never allowed to fail this already-committed
   * rotation. A transient failure here must not turn a successful refresh
   * into a client-visible error (which would also strip the idempotency
   * claim, so a client retry could trip reuse-detection on its own
   * successful call) — log and move on.
   */
  private async emitBestEffortSideEffects(
    session: RefreshTokenWithSession['session'],
    user: RefreshTokenWithSession['user'],
    dto: RotateInput,
  ): Promise<SnapshotResult | null> {
    if (session.currentJti && session.currentJtiExp) {
      try {
        await this.blacklist.addToBlacklist(
          session.currentJti,
          session.currentJtiExp,
        );
      } catch (err) {
        this.logger.warn(
          `Failed to blacklist superseded JTI for session ${session.id}`,
          err as Error,
        );
      }
    }
    try {
      await this.cacheInvalidator.invalidate(session.id);
    } catch (err) {
      this.logger.warn(
        `Failed to invalidate session cache for ${session.id}`,
        err as Error,
      );
    }

    // null when the client's snapshotVersion is already current — no payload needed.
    // A build failure degrades to "no snapshot change this response" rather
    // than failing the rotation; the client picks up the fresh snapshot on
    // its next request via the normal H-6 version-mismatch path.
    try {
      return await this.snapshot.getOrBuild(user.id, dto.snapshotVersion);
    } catch (err) {
      this.logger.warn(
        `Failed to build permission snapshot for user ${user.id}`,
        err as Error,
      );
      return null;
    }
  }
}
