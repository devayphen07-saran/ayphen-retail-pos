import { Module, Global, Injectable, Inject } from '@nestjs/common';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from './schema';
import { env } from '#config/env.js';
import { createPgClient } from './create-pg-client.js';

export const DRIZZLE = Symbol('DRIZZLE');

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

@Global()
@Module({
  providers: [
    {
      provide: DRIZZLE,
      useFactory: () => {
        const client = createPgClient(env.DATABASE_URL);
        return drizzle(client, { schema });
      },
    },
    UnitOfWork,
  ],
  exports: [DRIZZLE, UnitOfWork],
})
export class DbModule {}
