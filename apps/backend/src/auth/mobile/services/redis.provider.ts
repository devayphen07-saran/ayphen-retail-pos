import { Provider } from '@nestjs/common';
import Redis from 'ioredis';
import { AppConfigService } from '#config/app-config.service.js';

export const MOBILE_REDIS = Symbol('MOBILE_REDIS');

export const MobileRedisProvider: Provider = {
  provide: MOBILE_REDIS,
  inject: [AppConfigService],
  useFactory: (config: AppConfigService) =>
    new Redis(config.redisUrl || 'redis://localhost:6379', {
      maxRetriesPerRequest: 3,
      enableReadyCheck:     true,
      retryStrategy: (times: number) => Math.min(times * 200, 5000),
    }),
};
