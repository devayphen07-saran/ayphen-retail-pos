import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app/app.module.js';
import { env } from '#config/env.js';
import { applyGlobalConfig, setupSwagger } from './bootstrap/apply-global-config.js';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));

  applyGlobalConfig(app);
  setupSwagger(app);

  await app.listen(env.PORT);

  app.get(Logger).log(
    `Application is running on: http://localhost:${env.PORT}/api`,
  );
}

bootstrap();
