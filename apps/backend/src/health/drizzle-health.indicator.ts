import { Inject, Injectable } from '@nestjs/common';
import {
  HealthCheckError,
  HealthIndicator,
  HealthIndicatorResult,
} from '@nestjs/terminus';
import { sql } from 'drizzle-orm';
import { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DRIZZLE } from '#db/db.module.js';
import { errorMessage } from '#common/error-message.js';

@Injectable()
export class DrizzleHealthIndicator extends HealthIndicator {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase,
  ) {
    super();
  }

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    try {
      await this.db.execute(sql`SELECT 1`);
      return this.getStatus(key, true);
    } catch (err) {
      throw new HealthCheckError(
        'Database health check failed',
        this.getStatus(key, false, { message: errorMessage(err) }),
      );
    }
  }
}