import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { RbacRepository } from '../rbac.repository.js';

/**
 * SuperAdminGuard (rbac.md §10F). Protects /admin/* routes: verifies the user
 * holds the system-wide SUPER_ADMIN role. Throws 403 PERMISSION_DENIED if not.
 */
@Injectable()
export class SuperAdminGuard implements CanActivate {
  constructor(private readonly repo: RbacRepository) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request>();
    const principal = req.user;
    if (!principal) throw new UnauthorizedException('MISSING_AUTH');

    const ok = await this.repo.isSuperAdmin(principal.userId);
    if (!ok) throw new ForbiddenException('PERMISSION_DENIED');
    return true;
  }
}
