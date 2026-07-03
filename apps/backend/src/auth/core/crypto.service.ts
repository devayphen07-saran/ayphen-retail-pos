import { Injectable, OnModuleInit } from '@nestjs/common';
import { createHash, createHmac, timingSafeEqual, randomUUID } from 'crypto';
import { SignJWT, jwtVerify } from 'jose';
import { AppConfigService } from '#config/app-config.service.js';

export interface AccessTokenPayload {
  sub: string;
  jti: string;
  type: 'access';
  deviceSessionId: string;
  pv: number;   // user.permissionsVersion at issue time (rbac.md §16, H-6)
  iat: number;
  exp: number;
}

@Injectable()
export class CryptoService implements OnModuleInit {
  private currentSecret!: Uint8Array;

  constructor(private readonly config: AppConfigService) {}

  onModuleInit(): void {
    this.currentSecret = new TextEncoder().encode(this.config.jwtAccessSecret);
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

  async verifyJwt(token: string): Promise<AccessTokenPayload> {
    const { payload } = await jwtVerify(token, this.currentSecret, {
      algorithms: ['HS256'],
    });
    return payload as unknown as AccessTokenPayload;
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
