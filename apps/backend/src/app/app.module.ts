import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard } from '@nestjs/throttler';
import { AppConfigModule } from '#config/config.module.js';
import { LoggerModule } from '../logger/logger.module.js';
import { DbModule } from '#db/db.module.js';
import { HealthModule } from '../health/health.module.js';
import { ThrottleModule } from '../throttle/throttle.module.js';
import { RequestIdMiddleware } from '#common/middleware/request-id.middleware.js';
import { AuthCoreModule } from '#auth/core/auth-core.module.js';
import { MobileAuthModule } from '#auth/mobile/mobile-auth.module.js';
import { RbacModule } from '#common/rbac/rbac.module.js';
import { RouteCoverageModule } from '#common/rbac/route-coverage.module.js';
import { RedisModule } from '#common/redis/redis.module.js';
import { RequestContextModule } from '#common/request-context/request-context.module.js';
import { AuditModule } from '#common/audit/audit.module.js';
import { SharedRepositoriesModule } from '#common/shared-repositories.module.js';
import { StoresModule } from '../stores/stores.module.js';
import { SubscriptionModule } from '../subscription/subscription.module.js';
import { DevicesModule } from '../devices/devices.module.js';
import { LocationsModule } from '../locations/locations.module.js';
import { EntityTypesModule } from '../entity-types/entity-types.module.js';
import { LookupModule } from '../lookup/lookup.module.js';
import { ReferenceDataModule } from '../reference-data/reference-data.module.js';
import { SyncModule } from '../sync/sync.module.js';

@Module({
  imports: [
    AppConfigModule,
    LoggerModule,
    DbModule,
    HealthModule,
    ThrottleModule,
    ScheduleModule.forRoot(),
    RedisModule,
    RequestContextModule,
    AuditModule,
    SharedRepositoriesModule,
    AuthCoreModule,
    RbacModule,
    MobileAuthModule,
    StoresModule,
    SubscriptionModule,
    DevicesModule,
    LocationsModule,
    EntityTypesModule,
    LookupModule,
    ReferenceDataModule,
    SyncModule,
    RouteCoverageModule,   // last — runs route-config validation after all routes wired
  ],
  providers: [
    {
      provide:  APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(RequestIdMiddleware)
      .forRoutes({ path: '(.*)', method: RequestMethod.ALL });
  }
}
