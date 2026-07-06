import { Controller, Get } from '@nestjs/common';
import {
  DiskHealthIndicator,
  HealthCheck,
  HealthCheckService,
  type HealthCheckResult,
  MemoryHealthIndicator,
} from '@nestjs/terminus';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '#common/rbac/decorators/rbac.decorators.js';
import { DrizzleHealthIndicator } from './drizzle-health.indicator';
import { RedisHealthIndicator } from './redis-health.indicator';

@Public()
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(
    private readonly health:  HealthCheckService,
    private readonly db:      DrizzleHealthIndicator,
    private readonly redis:   RedisHealthIndicator,
    private readonly memory:  MemoryHealthIndicator,
    private readonly disk:    DiskHealthIndicator,
  ) {}

  /** Full check — db, redis, memory, disk. Human/monitoring use. */
  @Get()
  @HealthCheck()
  check(): Promise<HealthCheckResult> {
    return this.health.check([
      () => this.db.isHealthy('database'),
      () => this.redis.isHealthy('redis'),
      () => this.memory.checkHeap('memory_heap', 250 * 1024 * 1024),
      () => this.memory.checkRSS('memory_rss',   512 * 1024 * 1024),
      () => this.disk.checkStorage('disk', { thresholdPercent: 0.9, path: '/' }),
    ]);
  }

  /** Liveness probe — the process is up. No dependency checks, so a transient
   *  DB/Redis blip never kills the pod. */
  @Get('live')
  @HealthCheck()
  live(): Promise<HealthCheckResult> {
    return this.health.check([]);
  }

  /** Readiness probe — the process can serve traffic (db + redis reachable). */
  @Get('ready')
  @HealthCheck()
  ready(): Promise<HealthCheckResult> {
    return this.health.check([
      () => this.db.isHealthy('database'),
      () => this.redis.isHealthy('redis'),
    ]);
  }
}