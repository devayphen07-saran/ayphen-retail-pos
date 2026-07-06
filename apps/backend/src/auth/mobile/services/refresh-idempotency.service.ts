import { Inject, Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { CryptoService } from '../../core/crypto.service.js';
import { MOBILE_REDIS } from './redis.provider.js';

const KEY = (k: string) => `refresh_idem:${k}`;

/**
 * Split TTLs (flow-critic Phase 3):
 *
 * - PENDING (15s): bounds the lockout when a leader dies between SET NX and
 *   complete()/release() — followers stop timing out and a retry can become
 *   leader after at most 15s, instead of the old 60s of guaranteed 503s. A
 *   healthy rotation transaction finishes in well under a second; one that
 *   takes >15s is already pathological.
 *
 * - DONE (600s): the recovery window for a client that crashed after the
 *   server committed the rotation but before it persisted the new tokens —
 *   its relaunch retries with the OLD token and must get the identical
 *   cached pair back. At 60s that window lost the race with app-relaunch
 *   time and the retry tripped reuse-detection (family revoked, forced
 *   re-login); 10 minutes covers a kill + relaunch comfortably.
 */
const PENDING_TTL_SECONDS = 15;
/** Exported: RefreshTokenService sizes its challenge-reissue window off this
 *  (a used token may still need a challenge to unlock the cached record). */
export const REFRESH_IDEM_DONE_TTL_SECONDS = 600;
const DONE_TTL_SECONDS = REFRESH_IDEM_DONE_TTL_SECONDS;
const POLL_INTERVAL_MS = 200;
const POLL_TIMEOUT_MS  = 3_000;

/** Discriminated on `status` so a `done` record structurally guarantees its
 *  payload. `enc` is the AES-256-GCM-encrypted response: the rotation result
 *  carries a live access + refresh token pair, and a Redis dump/MONITOR
 *  alone must not yield usable sessions — especially now that done-records
 *  live 10 minutes instead of 60 seconds. */
type IdempotencyRecord =
  | { status: 'pending' }
  | { status: 'done'; enc: string };

/**
 * Three distinct outcomes for a caller of `claim()` (flow-critic review,
 * Finding A) — collapsing 'leader' and 'timed_out' into the same "proceed"
 * signal is what caused the original bug: a follower that gave up polling
 * would call `performRotation()` itself, and if the (merely slow, not dead)
 * leader was still mid-transaction, the follower's `markUsed` CAS would lose,
 * get treated as `REFRESH_TOKEN_REUSE`, and revoke the whole token family —
 * a false-positive security lockout caused by nothing more than DB latency.
 */
export type ClaimResult =
  | { role: 'leader' }
  | { role: 'cached'; response: unknown }
  | { role: 'timed_out' };

@Injectable()
export class RefreshIdempotencyService {
  private readonly logger = new Logger(RefreshIdempotencyService.name);

  constructor(
    @Inject(MOBILE_REDIS) private readonly redis: Redis,
    private readonly crypto: CryptoService,
  ) {}

  async claim(key: string): Promise<ClaimResult> {
    // Claim atomically first — SET NX is a single round-trip, so only one
    // racing caller can ever win it. Losers fall through to poll.
    const claimed = await this.redis.set(
      KEY(key),
      JSON.stringify({ status: 'pending' }),
      'EX',
      PENDING_TTL_SECONDS,
      'NX',
    );
    if (claimed === 'OK') return { role: 'leader' };

    const first = await this.readRecord(key);
    if (first === 'missing') return { role: 'leader' }; // claim already released/expired — proceed
    if (first !== 'pending') return first;

    // Pending — poll up to 3s for another server to finish
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);
      const polled = await this.readRecord(key);
      if (polled === 'missing') return { role: 'leader' }; // claim released mid-poll — proceed
      if (polled !== 'pending') return polled;
    }
    // Timed out with the leader still pending — do NOT proceed to rotate.
    // The caller must surface a retryable signal, never attempt the rotation
    // itself (that's the bug this type exists to prevent).
    return { role: 'timed_out' };
  }

  async complete(key: string, response: unknown): Promise<void> {
    const record: IdempotencyRecord = {
      status: 'done',
      enc:    this.crypto.encryptJson(response),
    };
    await this.redis.set(KEY(key), JSON.stringify(record), 'EX', DONE_TTL_SECONDS);
  }

  /**
   * Release a pending claim without storing a result — used when the operation
   * failed, so a retry isn't forced to poll for the full timeout before
   * re-attempting (and re-surfacing the original error).
   */
  async release(key: string): Promise<void> {
    const raw = await this.redis.get(KEY(key));
    if (!raw) return;
    const rec = JSON.parse(raw) as IdempotencyRecord;
    if (rec.status === 'pending') await this.redis.del(KEY(key));
  }

  /** Reads + decodes the record. A done-record that fails to decrypt (secret
   *  rotation, tamper) is unusable — surface 'timed_out' so the caller emits
   *  the retryable signal rather than starting a second live rotation that
   *  would race the CAS and trip reuse-detection. */
  private async readRecord(key: string): Promise<ClaimResult | 'pending' | 'missing'> {
    const raw = await this.redis.get(KEY(key));
    if (!raw) return 'missing';
    const rec = JSON.parse(raw) as IdempotencyRecord;
    if (rec.status === 'pending') return 'pending';
    try {
      return { role: 'cached', response: this.crypto.decryptJson(rec.enc) };
    } catch {
      this.logger.warn('Undecryptable refresh-idempotency record — treating as in-progress');
      return { role: 'timed_out' };
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
