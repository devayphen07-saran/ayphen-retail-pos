import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { UnauthorizedError } from '#common/exceptions/app.exception.js';
import { ErrorCodes } from '#common/error-codes.js';
import { REDIS } from '#common/redis/redis.provider.js';

const NONCE_TTL_SECONDS = 600; // 10 min
const TIMESTAMP_DRIFT_MS = 30_000; // ±30s

@Injectable()
export class ReplayProtectionService {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async check(deviceId: string, timestampHeader: string | undefined, nonceHeader: string | undefined): Promise<void> {
    if (!timestampHeader || !nonceHeader) {
      throw new UnauthorizedError(ErrorCodes.REPLAY_DETECTED, 'Missing replay-protection headers');
    }

    const ts = Number(timestampHeader);
    if (isNaN(ts) || Math.abs(Date.now() - ts) > TIMESTAMP_DRIFT_MS) {
      throw new UnauthorizedError(ErrorCodes.REPLAY_DETECTED, 'Request timestamp outside the allowed window');
    }

    const key = `nonce:${deviceId}:${nonceHeader}`;
    const set = await this.redis.set(key, '1', 'EX', NONCE_TTL_SECONDS, 'NX');
    if (!set) {
      throw new UnauthorizedError(ErrorCodes.REPLAY_DETECTED, 'Request nonce has already been used');
    }
  }
}
