import {
  Module,
  Global,
  Injectable,
  Inject,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Sql } from 'postgres';
import * as schema from './schema';
import { env } from '#config/env.js';
import { createPgClient } from './create-pg-client.js';

export const DRIZZLE = Symbol('DRIZZLE');
/** The raw postgres-js client behind the Drizzle handle — needed to drain the pool on shutdown. */
export const PG_CLIENT = Symbol('PG_CLIENT');

/** The application's Drizzle database handle (postgres-js driver). */
export type Database = PostgresJsDatabase<typeof schema>;

/** A transaction handle, as passed to the callback of `db.transaction(...)`. */
export type DbTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * Anything a repository can run queries against — the root handle or a live
 * transaction. Repositories accept `tx?: DbExecutor` and fall back to their
 * injected `db`, so the same method works inside or outside a transaction.
 */
export type DbExecutor = Database | DbTransaction;

/**
 * Unit of Work — runs a set of writes inside a single transaction. Pass the
 * `tx` it yields into each repository call so they all commit or roll back
 * together.
 */
@Injectable()
export class UnitOfWork {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  execute<T>(work: (tx: DbTransaction) => Promise<T>): Promise<T> {
    return this.db.transaction((tx) => work(tx));
  }
}

/**
 * Drains the connection pool when Nest shuts down (SIGTERM/SIGINT), so
 * in-flight queries finish and sockets close cleanly instead of being killed.
 * Relies on `app.enableShutdownHooks()` in main.ts.
 */
@Injectable()
export class DatabaseLifecycle implements OnApplicationShutdown {
  constructor(@Inject(PG_CLIENT) private readonly client: Sql) {}

  async onApplicationShutdown(): Promise<void> {
    await this.client.end({ timeout: 5 });
  }
}

@Global()
@Module({
  providers: [
    {
      provide: PG_CLIENT,
      useFactory: () => createPgClient(env.DATABASE_URL, { max: env.DB_POOL_MAX }),
    },
    {
      provide: DRIZZLE,
      useFactory: (client: Sql) => drizzle(client, { schema }),
      inject: [PG_CLIENT],
    },
    UnitOfWork,
    DatabaseLifecycle,
  ],
  exports: [DRIZZLE, UnitOfWork],
})
export class DbModule {}
