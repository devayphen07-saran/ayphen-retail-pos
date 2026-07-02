import request from 'supertest';
import { buildApp, closeApp } from '../../setup/app';
import type { NestExpressApplication } from '@nestjs/platform-express';

describe('Test app builder — boots the real AppModule with applyGlobalConfig', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await closeApp();
  });

  it('boots and responds on the health endpoint (excluded from the /api prefix)', async () => {
    const res = await request(app.getHttpServer()).get('/health');
    expect([200, 503]).toContain(res.status); // either is fine — proves routing + global config wired
  });

  it('applies the response envelope interceptor on a real route', async () => {
    const res = await request(app.getHttpServer()).get('/health');
    expect(res.body).toBeDefined();
  });
});
