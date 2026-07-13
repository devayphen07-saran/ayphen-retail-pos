import { Injectable, OnModuleInit } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';
import { AppConfigService } from '#config/app-config.service.js';
import { BadRequestError, GoneError } from '#common/exceptions/app.exception.js';
import { ErrorCodes } from '#common/error-codes.js';
import {
  CURSOR_HMAC_DOMAIN,
  SYNC_CURSOR_VERSION,
  SYNC_HORIZON_MS,
} from '../sync.constants.js';
import { MICRO_ISO_RE, microIsoFromDate } from '../us-timestamp.js';

/** One entity's delta keyset position: (modified_at µs string, tiebreak id). */
export interface EntityWatermark {
  ts: string;
  id: string;
}

/**
 * The signed v4 cursor payload (sync-engine.md §4).
 *
 * - `u`/`s` bind the cursor to (user, store) — cross-tenant replay rejected.
 * - `ia` is re-minted on EVERY response, so the 180-day horizon only fires for
 *   a client offline that long (S-31: NEVER key the horizon on a per-entity
 *   `ts` — a low-churn entity legitimately carries an ancient watermark).
 * - `e` per-entity upsert watermarks; `t` the shared tombstone watermark.
 */
export interface SyncCursorPayload {
  v: number;
  u: string;
  s: string;
  ia: number;
  e: Record<string, EntityWatermark>;
  t?: EntityWatermark;
}

/**
 * Opaque, HMAC-signed cursor codec. Wire format:
 * `base64url(json payload) . base64url(hmac-sha256)`.
 *
 * The key is domain-separated from the root secret — the cursor MAC can never
 * be confused with a JWT or snapshot signature even if the root secret is
 * shared in dev.
 */
@Injectable()
export class SyncCursorService implements OnModuleInit {
  private key!: Buffer;

  constructor(private readonly config: AppConfigService) {}

  onModuleInit(): void {
    this.key = createHmac('sha256', this.config.syncRootSecret)
      .update(CURSOR_HMAC_DOMAIN)
      .digest();
  }

  /** Mint a fresh cursor. `ia` is always server-now — never carried over. */
  mint(
    userId: string,
    storeId: string,
    entities: Record<string, EntityWatermark>,
    tombstone?: EntityWatermark,
    now: Date = new Date(),
  ): string {
    const payload: SyncCursorPayload = {
      v: SYNC_CURSOR_VERSION,
      u: userId,
      s: storeId,
      ia: now.getTime(),
      e: entities,
      ...(tombstone ? { t: tombstone } : {}),
    };
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${body}.${this.mac(body)}`;
  }

  /**
   * Verify + decode a cursor for this (user, store).
   *
   * - tampered / malformed / wrong version / wrong tenant → 400 INVALID_CURSOR
   *   (tenant mismatch is deliberately indistinguishable from garbage)
   * - `ia` older than the horizon → 410 SYNC_HORIZON_EXCEEDED → client restarts
   *   at /sync/initial
   * - future watermarks are clamped to server-now (a forged future cursor can
   *   delay rows, never permanently skip them)
   */
  decode(cursor: string, userId: string, storeId: string, now: Date = new Date()): SyncCursorPayload {
    const dot = cursor.lastIndexOf('.');
    if (dot <= 0 || dot === cursor.length - 1) this.invalid();

    const body = cursor.slice(0, dot);
    const mac = cursor.slice(dot + 1);
    const expected = this.mac(body);
    const macBuf = Buffer.from(mac, 'base64url');
    const expectedBuf = Buffer.from(expected, 'base64url');
    if (macBuf.length !== expectedBuf.length || !timingSafeEqual(macBuf, expectedBuf)) {
      this.invalid();
    }

    let payload: SyncCursorPayload;
    try {
      payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as SyncCursorPayload;
    } catch {
      this.invalid();
    }

    if (payload.v !== SYNC_CURSOR_VERSION) this.invalid();
    if (payload.u !== userId || payload.s !== storeId) this.invalid();
    if (typeof payload.ia !== 'number' || !Number.isFinite(payload.ia)) this.invalid();

    // Horizon — keyed on `ia` ONLY (S-31). Re-minted each poll, so it ages out
    // only for a genuinely long-offline client.
    if (now.getTime() - payload.ia > SYNC_HORIZON_MS) {
      throw new GoneError(
        ErrorCodes.SYNC_HORIZON_EXCEEDED,
        'Sync cursor is older than the horizon — restart at /sync/initial',
      );
    }

    const nowMicro = microIsoFromDate(now);
    const clamp = (w: unknown): EntityWatermark => {
      const wm = w as EntityWatermark;
      if (
        typeof wm !== 'object' || wm === null ||
        typeof wm.ts !== 'string' || typeof wm.id !== 'string' ||
        !MICRO_ISO_RE.test(wm.ts)
      ) {
        this.invalid();
      }
      // Future-timestamp clamp: fixed-width UTC ISO strings compare as time.
      return wm.ts > nowMicro ? { ts: nowMicro, id: wm.id } : wm;
    };

    if (typeof payload.e !== 'object' || payload.e === null) this.invalid();
    const entities: Record<string, EntityWatermark> = {};
    for (const [entity, wm] of Object.entries(payload.e)) {
      entities[entity] = clamp(wm);
    }

    return {
      v: payload.v,
      u: payload.u,
      s: payload.s,
      ia: Math.min(payload.ia, now.getTime()),
      e: entities,
      ...(payload.t !== undefined ? { t: clamp(payload.t) } : {}),
    };
  }

  private mac(body: string): string {
    return createHmac('sha256', this.key).update(body).digest('base64url');
  }

  private invalid(): never {
    throw new BadRequestError(ErrorCodes.INVALID_CURSOR, 'The sync cursor is invalid');
  }
}
