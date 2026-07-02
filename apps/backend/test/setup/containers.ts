import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';

let pg: StartedPostgreSqlContainer;
let redis: StartedRedisContainer;

/** Boots Postgres + Redis once for the whole run. Called only from globalSetup. */
export async function startContainers() {
  // Start both in parallel — saves several seconds per run
  [pg, redis] = await Promise.all([
    new PostgreSqlContainer('postgres:17-alpine') // matches apps/backend/docker-compose.yml
      .withDatabase('ayphen_test')
      .withUsername('test')
      .withPassword('test')
      // tmpfs: data lives in RAM, never touches disk — much faster for tests
      .withTmpFs({ '/var/lib/postgresql/data': 'rw' })
      .start(),
    new RedisContainer('redis:7-alpine').start(),
  ]);

  return {
    pg,
    redis,
    databaseUrl:       pg.getConnectionUri(),
    redisUrl:          redis.getConnectionUrl(),
    pgContainerId:     pg.getId(),
    redisContainerId:  redis.getId(),
  };
}

/**
 * globalTeardown runs in a separate process from globalSetup, so the `pg`/
 * `redis` module-level handles above are never populated there — stop by ID
 * via the raw Docker client instead of relying on the typed wrapper.
 */
export async function stopContainersById(ids: { pgContainerId: string; redisContainerId: string }) {
  const { getContainerRuntimeClient } = await import('testcontainers');
  const client = await getContainerRuntimeClient();

  await Promise.all(
    [ids.pgContainerId, ids.redisContainerId].map(async (id) => {
      const container = client.container.getById(id);
      await client.container.stop(container);
      await client.container.remove(container);
    }),
  );
}
