import { Global, Module } from '@nestjs/common';
import { REDIS } from '#common/redis/redis.provider.js';
import { CORE_REDIS } from './core.tokens.js';
import { CryptoService } from './crypto.service.js';
import { PasswordService } from './password.service.js';
import { RateLimitRepository } from './rate-limit.repository.js';
import { RateLimitService } from './rate-limit.service.js';
import { LoginAttemptsCleanupService } from './login-attempts-cleanup.service.js';
import { Msg91Service } from './msg91.service.js';

// Re-export for existing importers of `CORE_REDIS` from this module path.
export { CORE_REDIS } from './core.tokens.js';

// CORE_REDIS aliases the single shared REDIS connection (provided by the
// global RedisModule) rather than opening a second physical connection to the
// same Redis instance. Consumers that inject CORE_REDIS get the exact same
// ioredis client — one connection app-wide, as RedisModule's doc promises.
const CoreRedisProvider = {
  provide: CORE_REDIS,
  useExisting: REDIS,
};

@Global()
@Module({
  providers: [
    CoreRedisProvider,
    CryptoService,
    PasswordService,
    RateLimitRepository,
    RateLimitService,
    LoginAttemptsCleanupService,
    Msg91Service,
  ],
  exports: [
    CORE_REDIS,
    CryptoService,
    PasswordService,
    RateLimitRepository,
    RateLimitService,
    Msg91Service,
  ],
})
export class AuthCoreModule {}
