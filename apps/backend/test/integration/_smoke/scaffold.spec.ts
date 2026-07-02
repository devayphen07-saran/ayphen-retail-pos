import { sql } from 'drizzle-orm';
import { getDb } from '../../setup/db';
import { getRedis } from '../../setup/redis';
import { users } from '../../../src/db/schema';

describe('Test scaffolding smoke test', () => {
  it('DATABASE_URL and REDIS_URL are set from the container handoff', () => {
    expect(process.env.DATABASE_URL).toMatch(/^postgres(ql)?:\/\//);
    expect(process.env.REDIS_URL).toMatch(/^redis:\/\//);
  });

  it('can query the real Postgres container and see the migrated schema', async () => {
    const db = getDb();
    const rows = await db.execute(sql`select 1 as one`);
    expect(rows[0]).toEqual({ one: 1 });

    // users table must exist — proves migrations ran
    const result = await db.select().from(users);
    expect(result).toEqual([]); // truncated fresh by beforeEach
  });

  it('can talk to the real Redis container', async () => {
    const redis = getRedis();
    await redis.set('smoke', 'ok');
    expect(await redis.get('smoke')).toBe('ok');
  });

  it('resetAll() truncates between tests — no leftover rows from the previous test', async () => {
    const db = getDb();
    await db.insert(users).values({
      phone: '+919876500000',
      name: 'Smoke Test User',
    });

    const rows = await db.select().from(users);
    expect(rows.length).toBe(1);
  });

  it('previous test row is gone — beforeEach truncated it', async () => {
    const db = getDb();
    const rows = await db.select().from(users);
    expect(rows.length).toBe(0);
  });
});
