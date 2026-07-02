import { Controller, Get } from '@nestjs/common';
import {
  DiskHealthIndicator,
  HealthCheck,
  HealthCheckService,
  MemoryHealthIndicator,
} from '@nestjs/terminus';
import { SkipThrottle } from '@nestjs/throttler';
import { DrizzleHealthIndicator } from './drizzle-health.indicator';

@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(
    private readonly health:  HealthCheckService,
    private readonly db:      DrizzleHealthIndicator,
    private readonly memory:  MemoryHealthIndicator,
    private readonly disk:    DiskHealthIndicator,
  ) {}

  @Get()
  @HealthCheck()
  check() {
    return this.health.check([
      () => this.db.isHealthy('database'),
      () => this.memory.checkHeap('memory_heap', 250 * 1024 * 1024),
      () => this.memory.checkRSS('memory_rss',   512 * 1024 * 1024),
      () => this.disk.checkStorage('disk', { thresholdPercent: 0.9, path: '/' }),
    ]);
  }
}
