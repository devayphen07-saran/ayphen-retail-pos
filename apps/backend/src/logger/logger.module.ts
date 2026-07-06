import { Global, Module } from '@nestjs/common';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import type { Request } from 'express';
import { env } from '#config/env.js';
import type { MobilePrincipal } from '#common/types/principal.js';
import type { ResolvedStoreContext } from '#common/rbac/resolved-store-context.js';

@Global()
@Module({
  imports: [
    PinoLoggerModule.forRoot({
      pinoHttp: {
        level: env.NODE_ENV === 'production' ? 'info' : 'debug',
        // pino-pretty for human-readable output in development only
        transport:
          env.NODE_ENV !== 'production'
            ? { target: 'pino-pretty', options: { colorize: true, singleLine: false } }
            : undefined,
        // Use existing x-request-id header or generate one — actual generation
        // is handled by RequestIdMiddleware (section 2.3); this just reads it.
        genReqId: (req) => req.headers['x-request-id'] as string,
        customProps: (req) => {
          const r = req as Request & {
            user?:    MobilePrincipal;
            context?: ResolvedStoreContext;
          };
          return {
            requestId: r.headers['x-request-id'],
            userId:    r.user?.userId,
            storeId:   r.context?.storeId,
          };
        },
        serializers: {
          req: (req) => ({ method: req.method, url: req.url }),
          res: (res) => ({ statusCode: res.statusCode }),
        },
      },
    }),
  ],
})
export class LoggerModule {}
