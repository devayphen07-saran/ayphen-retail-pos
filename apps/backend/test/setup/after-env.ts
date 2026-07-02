import { resetAll } from './truncate';
import { closeDb } from './db';
import { closeRedis } from './redis';

beforeEach(async () => {
  await resetAll(); // truncate all tables + flush Redis
});

afterAll(async () => {
  await closeDb();
  await closeRedis();
});
