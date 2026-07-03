import type { NestExpressApplication } from '@nestjs/platform-express';
import { ValidationPipe, RequestMethod } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';
import { env } from '#config/env.js';
import { corsConfig } from '#config/cors.config.js';
import { swaggerDocConfig, swaggerUiOptions } from '#config/swagger.config.js';
import { AppException } from '#common/exceptions/app.exception.js';
import { ErrorCodes } from '#common/error-codes.js';
import { AllExceptionsFilter } from '#common/filters/http-exception.filter.js';
import { ResponseInterceptor } from '#common/interceptors/response.interceptor.js';
import { RequestContextInterceptor } from '#common/interceptors/request-context.interceptor.js';
import { SubscriptionHeadersInterceptor } from '#common/interceptors/subscription-headers.interceptor.js';
import { TrimStringPipe } from '#common/pipes/trim-string.pipe.js';

/**
 * Same pipes/filters/interceptors as production, applied identically in
 * main.ts and in the test app builder — a test app that diverges from this
 * is exactly where guard/pipe bugs hide undetected.
 */
export function applyGlobalConfig(app: NestExpressApplication): void {
  // 0. Harden Express defaults
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  // 0b. 30-second hard request timeout
  app.use((req: import('express').Request, res: import('express').Response, next: import('express').NextFunction) => {
    req.setTimeout(30_000, () => {
      res.status(408).json({ success: false, statusCode: 408, message: 'Request timeout', errorCode: 'REQUEST_TIMEOUT' });
    });
    next();
  });

  // 1. CORS
  app.enableCors(corsConfig);

  // 1b. Body size limits — reject oversized JSON payloads early (before pipes/guards).
  // `verify` stashes the raw bytes on req.rawBody so payment webhooks can validate
  // their HMAC signature over the exact payload the provider sent.
  app.useBodyParser('json', {
    limit: env.JSON_BODY_LIMIT,
    verify: (req: { rawBody?: Buffer }, _res: unknown, buf: Buffer) => {
      req.rawBody = buf;
    },
  });
  app.useBodyParser('urlencoded', { limit: env.JSON_BODY_LIMIT, extended: true });

  // 2. Global prefix — exclude /health and /docs so probes and Swagger hit bare paths
  app.setGlobalPrefix('api', {
    exclude: [
      { path: 'health',    method: RequestMethod.GET },
      { path: 'docs',      method: RequestMethod.GET },
      { path: 'docs/(.*)', method: RequestMethod.GET },
    ],
  });

  // 3. Exception filter — before pipes so it catches pipe and guard errors
  app.useGlobalFilters(new AllExceptionsFilter());

  // 4. Pipes — TrimStringPipe must come before ValidationPipe so @IsNotEmpty()
  //    sees already-trimmed values ("   " becomes null before validation runs)
  app.useGlobalPipes(
    new TrimStringPipe(),
    new ValidationPipe({
      whitelist:            true,
      forbidNonWhitelisted: true,
      transform:            true,
      transformOptions:     { enableImplicitConversion: true },
      exceptionFactory: (errors) => {
        const messages = errors.flatMap((e) => Object.values(e.constraints ?? {}));
        return new AppException(ErrorCodes.VALIDATION_FAILED, messages.join('; '), 422);
      },
    }),
  );

  // 5. Interceptors — RequestContext first (wraps AsyncLocalStorage), then Response envelope
  app.useGlobalInterceptors(
    new RequestContextInterceptor(),
    new SubscriptionHeadersInterceptor(),
    new ResponseInterceptor(app.get(Reflector)),
  );
}

/** Swagger setup is separate from applyGlobalConfig — main.ts only; test apps don't need docs. */
export function setupSwagger(app: NestExpressApplication): void {
  const document = SwaggerModule.createDocument(app, swaggerDocConfig);
  SwaggerModule.setup('docs', app, document, swaggerUiOptions);
}
