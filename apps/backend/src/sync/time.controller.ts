import { Controller, Get } from '@nestjs/common';
import { Public, StoreContext } from '#common/rbac/decorators/rbac.decorators.js';
import { SkipTransform } from '#common/decorators/skip-transform.decorator.js';

/**
 * Server clock for client skew correction (sync-engine.md §2). Unauthenticated
 * by design: a clock-fast device must be able to learn its offset BEFORE
 * authenticating — MobileJwtGuard's replay protection rejects requests whose
 * X-Timestamp drifts more than ±30 s, so this is the bootstrap out of that hole.
 */
@Controller('time')
@StoreContext('none')
export class TimeController {
  @Get()
  @Public()
  @SkipTransform()
  now(): { server_time: string; epoch_ms: number } {
    const d = new Date();
    return { server_time: d.toISOString(), epoch_ms: d.getTime() };
  }
}