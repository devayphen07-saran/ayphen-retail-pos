import { NestFactory } from '@nestjs/core';
import { Module } from '@nestjs/common';
import { DbModule } from '../../../src/db/db.module';
import { AuthCoreModule } from '../../../src/auth/core/auth-core.module';
import { RedisModule } from '../../../src/common/redis/redis.module';
import { AppConfigModule } from '../../../src/config/config.module';

@Module({ imports: [AppConfigModule, DbModule, RedisModule, AuthCoreModule] })
class TestRootModule {}

describe('NestFactory.create boot (not TestingModule)', () => {
  it('boots without DI error', async () => {
    const app = await NestFactory.create(TestRootModule, { logger: false, abortOnError: false });
    expect(app).toBeDefined();
    await app.close();
  });
});