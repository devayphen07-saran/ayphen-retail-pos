import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from '../../src/app/app.module';
import { applyGlobalConfig } from '../../src/bootstrap/apply-global-config';

let app: NestExpressApplication;

/** Same pipes/filters/interceptors as production — see applyGlobalConfig. */
export async function buildApp(): Promise<NestExpressApplication> {
  if (app) return app;

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule], // real module — process.env already points at the containers
  }).compile();

  app = moduleRef.createNestApplication<NestExpressApplication>();
  applyGlobalConfig(app);
  await app.init();
  return app;
}

export async function closeApp() {
  await app?.close();
  app = undefined as unknown as NestExpressApplication;
}
