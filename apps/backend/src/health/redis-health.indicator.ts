import { Inject, Injectable } from '@nestjs/common';
import {
  HealthCheckError,
  HealthIndicator,
  HealthIndicatorResult,
} from '@nestjs/terminus';
import Redis from 'ioredis';
import { errorMessage } from '#common/error-message.js';
import { REDIS } from '#common/redis/redis.provider.js';

@Injectable()
export class RedisHealthIndicator extends HealthIndicator {
  constructor(@Inject(REDIS) private readonly redis: Redis) {
    super();
  }

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    try {
      const pong = await this.redis.ping();
      if (pong !== 'PONG') throw new Error(`unexpected PING reply: ${pong}`);
      return this.getStatus(key, true);
    } catch (err) {
      throw new HealthCheckError(
        'Redis health check failed',
        this.getStatus(key, false, { message: errorMessage(err) }),
      );
    }
  }
}
