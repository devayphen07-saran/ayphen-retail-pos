import { Global, Module } from '@nestjs/common';
import { RedisProvider } from './redis.provider.js';

/**
 * Single shared ioredis connection (token: REDIS), exposed app-wide.
 * The auth layer, the RBAC layer, and the core layer all resolve the same
 * instance from here — REDIS directly, and CORE_REDIS via `useExisting`
 * (see auth-core.module.ts) — so there is exactly one physical connection
 * rather than one per consuming module.
 */
@Global()
@Module({
  providers: [RedisProvider],
  exports: [RedisProvider],
})
export class RedisModule {}
