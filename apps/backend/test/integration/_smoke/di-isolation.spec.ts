import { Test } from '@nestjs/testing';
import { AuthCoreModule, CORE_REDIS } from '../../../src/auth/core/auth-core.module';
import { UserRevocationCacheService } from '../../../src/auth/core/user-revocation-cache.service';
import { DbModule } from '../../../src/db/db.module';

describe('DI isolation — AuthCoreModule alone', () => {
  it('resolves UserRevocationCacheService with CORE_REDIS and DRIZZLE', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [DbModule, AuthCoreModule],
    }).compile();

    const svc = moduleRef.get(UserRevocationCacheService);
    expect(svc).toBeDefined();

    const redis = moduleRef.get(CORE_REDIS);
    expect(redis).toBeDefined();

    await moduleRef.close();
  });
});
