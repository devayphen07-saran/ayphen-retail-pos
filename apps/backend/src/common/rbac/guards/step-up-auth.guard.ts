import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import {
  IS_PUBLIC_KEY,
  STEP_UP_AUTH_KEY,
  type StepUpAuthMeta,
} from '../decorators/rbac.decorators.js';

/** Parse a short duration like '5m', '30s', '2h' → milliseconds. */
function parseDurationMs(spec: string): number {
  const m = /^(\d+)(s|m|h)$/.exec(spec.trim());
  if (!m) throw new Error(`Invalid @StepUpAuth window: "${spec}"`);
  const n = Number(m[1]);
  const unit = { s: 1_000, m: 60_000, h: 3_600_000 }[m[2] as 's' | 'm' | 'h'];
  return n * unit;
}

/**
 * StepUpAuthGuard (rbac.md §10D). Requires a recent step-up (MFA) within the
 * window declared by @StepUpAuth({ within }). Reads session.lastStepUpAt (loaded
 * onto the principal by MobileJwtGuard). Routes without @StepUpAuth pass through.
 */
@Injectable()
export class StepUpAuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const meta = this.reflector.getAllAndOverride<StepUpAuthMeta>(STEP_UP_AUTH_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!meta) return true;

    const req = ctx.switchToHttp().getRequest<Request>();
    const principal = req.user;
    if (!principal) throw new UnauthorizedException('MISSING_AUTH');

    const withinMs = parseDurationMs(meta.within);
    const stepUpAt = principal.stepUpAt;
    if (!stepUpAt || Date.now() - stepUpAt.getTime() > withinMs) {
      throw new ForbiddenException('STEP_UP_AUTH_REQUIRED');
    }
    return true;
  }
}
