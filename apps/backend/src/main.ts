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

  // Drain the pg pool / Redis and run OnApplicationShutdown hooks on SIGTERM/SIGINT.
  app.enableShutdownHooks();

  await app.listen(env.PORT);

  app.get(Logger).log(
    `Application is running on: http://localhost:${env.PORT}/api`,
  );
}

bootstrap().catch((err) => {
  // Startup failed before the logger is wired — fall back to console and exit
  // non-zero so the orchestrator restarts / halts the rollout.
  console.error('Fatal: application failed to start', err);
  process.exit(1);
});
