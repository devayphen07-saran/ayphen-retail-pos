import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { MOBILE_REDIS } from './redis.provider.js';

const KEY = (k: string) => `refresh_idem:${k}`;
const TTL = 60;
const POLL_INTERVAL_MS = 200;
const POLL_TIMEOUT_MS  = 3_000;

interface IdempotencyRecord {
  status:    'pending' | 'done';
  response?: unknown;
}

@Injectable()
export class RefreshIdempotencyService {
  constructor(@Inject(MOBILE_REDIS) private readonly redis: Redis) {}

  async claim(key: string): Promise<unknown | null> {
    const raw = await this.redis.get(KEY(key));

    if (raw) {
      const rec = JSON.parse(raw) as IdempotencyRecord;
      if (rec.status === 'done') return rec.response!;

      // Pending — poll up to 3s for another server to finish
      const deadline = Date.now() + POLL_TIMEOUT_MS;
      while (Date.now() < deadline) {
        await sleep(POLL_INTERVAL_MS);
        const polled = await this.redis.get(KEY(key));
        if (!polled) break;
        const p = JSON.parse(polled) as IdempotencyRecord;
        if (p.status === 'done') return p.response!;
      }
      return null; // timed out — let this request proceed
    }

    // Claim key as pending
    await this.redis.set(KEY(key), JSON.stringify({ status: 'pending' }), 'EX', TTL, 'NX');
    return null; // proceed with rotation
  }

  async complete(key: string, response: unknown): Promise<void> {
    await this.redis.set(
      KEY(key),
      JSON.stringify({ status: 'done', response }),
      'EX',
      TTL,
    );
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
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
