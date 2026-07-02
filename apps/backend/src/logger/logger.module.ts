import { Global, Module } from '@nestjs/common';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import { env } from '../config/env';

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
        customProps: (req: any) => ({
          requestId: req.headers['x-request-id'],
          userId:    req.user?.id,
          storeId:   req.user?.storeId,
        }),
        serializers: {
          req: (req) => ({ method: req.method, url: req.url }),
          res: (res) => ({ statusCode: res.statusCode }),
        },
      },
    }),
  ],
})
export class LoggerModule {}
