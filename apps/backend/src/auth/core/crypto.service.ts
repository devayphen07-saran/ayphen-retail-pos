import { Injectable, OnModuleInit } from '@nestjs/common';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'crypto';
import { SignJWT, jwtVerify } from 'jose';
import { z } from 'zod';
import { AppConfigService } from '#config/app-config.service.js';
import { UnauthorizedError } from '#common/exceptions/app.exception.js';
import { ErrorCodes } from '#common/error-codes.js';

export interface AccessTokenPayload {
  sub: string;
  jti: string;
  type: 'access';
  deviceSessionId: string;
  pv: number;   // user.permissionsVersion at issue time (rbac.md §16, H-6)
  iat: number;
  exp: number;
}

/**
 * `jose` verifies the signature but not the claim shape. This schema validates
 * the decoded payload so downstream code isn't trusting a blind cast. `type` is
 * kept loose here so the guard can raise its distinct `INVALID_TOKEN_TYPE`.
 */
const VerifiedClaimsSchema = z.object({
  sub:             z.string(),
  jti:             z.string(),
  type:            z.string(),
  deviceSessionId: z.string(),
  pv:              z.number(),
  iat:             z.number(),
  exp:             z.number(),
});

export type VerifiedAccessClaims = z.infer<typeof VerifiedClaimsSchema>;

@Injectable()
export class CryptoService implements OnModuleInit {
  private currentSecret!: Uint8Array;
  private cacheEncKey!: Buffer;

  constructor(private readonly config: AppConfigService) {}

  onModuleInit(): void {
    this.currentSecret = new TextEncoder().encode(this.config.jwtAccessSecret);
    // Domain-separated key for encrypting cached secrets at rest (e.g. the
    // refresh-idempotency result record in Redis) — derived, never stored.
    this.cacheEncKey = createHash('sha256')
      .update(`cache-encryption:${this.config.jwtRefreshSecret}`)
      .digest();
  }

  // ── JWT ────────────────────────────────────────────────────────────────────

  async signJwt(
    sub: string,
    deviceSessionId: string,
    permissionsVersion: number,
  ): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      type: 'access',
      deviceSessionId,
      pv: permissionsVersion,
    } satisfies Omit<AccessTokenPayload, 'sub' | 'jti' | 'iat' | 'exp'>)
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(sub)
      .setJti(randomUUID())
      .setIssuedAt(now)
      .setExpirationTime(now + this.config.accessTokenTtlSeconds)
      .sign(this.currentSecret);
  }

  /**
   * Decode (without verifying) the `jti`/`exp` claims of a token this process
   * itself just signed — used to persist `currentJti`/`currentJtiExp`
   * alongside the session/token row that issued it, in the same transaction.
   * Never use this on an externally-supplied token; that must go through
   * `verifyJwt`.
   */
  decodeOwnJwtClaims(token: string): { jti: string; exp: number } {
    const parts = token.split('.');
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString()) as {
      jti: string;
      exp: number;
    };
    return payload;
  }

  async verifyJwt(token: string): Promise<VerifiedAccessClaims> {
    let payload: unknown;
    try {
      ({ payload } = await jwtVerify(token, this.currentSecret, {
        algorithms: ['HS256'],
      }));
    } catch {
      // Expired / bad-signature / tampered / malformed → 401, not an uncaught
      // JOSEError that the global filter turns into a 500 with a stack trace.
      // Token expiry is the single most common auth event.
      throw new UnauthorizedError(ErrorCodes.TOKEN_INVALID, 'Invalid or expired access token');
    }
    const parsed = VerifiedClaimsSchema.safeParse(payload);
    if (!parsed.success) {
      throw new UnauthorizedError(ErrorCodes.TOKEN_INVALID, 'Malformed access token');
    }
    return parsed.data;
  }

  // ── Snapshot signing (Ed25519 placeholder — uses HMAC-SHA256 until key pair provisioned) ──

  signSnapshot(canonicalJson: string): string {
    return createHmac('sha256', this.config.jwtAccessSecret)
      .update(canonicalJson)
      .digest('hex');
  }

  verifySnapshot(canonicalJson: string, signature: string): boolean {
    const expected = this.signSnapshot(canonicalJson);
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(signature, 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  }

  // ── Device signature (Ed25519 via SubtleCrypto) ───────────────────────────

  async verifyDeviceSignature(
    publicKeyBase64: string,
    challenge: string,
    signatureHex: string,
  ): Promise<boolean> {
    try {
      const keyBytes  = Buffer.from(publicKeyBase64, 'base64');
      const sigBytes  = Buffer.from(signatureHex, 'hex');
      const msgBytes  = Buffer.from(challenge);

      const cryptoKey = await globalThis.crypto.subtle.importKey(
        'raw',
        keyBytes,
        { name: 'Ed25519' },
        false,
        ['verify'],
      );

      return await globalThis.crypto.subtle.verify(
        { name: 'Ed25519' },
        cryptoKey,
        sigBytes,
        msgBytes,
      );
    } catch {
      return false;
    }
  }

  // ── Cache encryption (AES-256-GCM) ─────────────────────────────────────────
  // For values that must transit Redis but contain live secrets (token pairs
  // in the refresh-idempotency record). A Redis dump/MONITOR alone must not
  // yield usable sessions (flow-critic Phase 3).

  encryptJson(value: unknown): string {
    const iv     = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.cacheEncKey, iv);
    const ct     = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
  }

  /** Throws on tamper/key-rotation — callers treat that as a cache miss. */
  decryptJson(payload: string): unknown {
    const buf = Buffer.from(payload, 'base64');
    const iv  = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const ct  = buf.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', this.cacheEncKey, iv);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return JSON.parse(pt.toString('utf8'));
  }

  // ── Utilities ──────────────────────────────────────────────────────────────

  hashToken(raw: string): string {
    return createHash('sha256').update(raw).digest('hex');
  }

  canonicalJson(obj: unknown): string {
    return JSON.stringify(this.sortedDeep(obj));
  }

  private sortedDeep(val: unknown): unknown {
    if (Array.isArray(val)) return val.map((v) => this.sortedDeep(v));
    if (val !== null && typeof val === 'object') {
      return Object.fromEntries(
        Object.entries(val as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => [k, this.sortedDeep(v)]),
      );
    }
    return val;
  }
}
