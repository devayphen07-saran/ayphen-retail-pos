import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import Redis from 'ioredis';
import { MOBILE_REDIS } from './redis.provider.js';

const NONCE_TTL_SECONDS = 600; // 10 min
const TIMESTAMP_DRIFT_MS = 30_000; // ±30s

@Injectable()
export class ReplayProtectionService {
  constructor(@Inject(MOBILE_REDIS) private readonly redis: Redis) {}

  async check(deviceId: string, timestampHeader: string | undefined, nonceHeader: string | undefined): Promise<void> {
    if (!timestampHeader || !nonceHeader) {
      throw new UnauthorizedException('REPLAY_DETECTED');
    }

    const ts = Number(timestampHeader);
    if (isNaN(ts) || Math.abs(Date.now() - ts) > TIMESTAMP_DRIFT_MS) {
      throw new UnauthorizedException('REPLAY_DETECTED');
    }

    const key = `nonce:${deviceId}:${nonceHeader}`;
    const set = await this.redis.set(key, '1', 'EX', NONCE_TTL_SECONDS, 'NX');
    if (!set) {
      throw new UnauthorizedException('REPLAY_DETECTED');
    }
  }
}
