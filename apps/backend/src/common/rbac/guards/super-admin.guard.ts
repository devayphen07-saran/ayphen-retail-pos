import {
  CanActivate,
  ExecutionContext,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';
import { ForbiddenError, UnauthorizedError } from '#common/exceptions/app.exception.js';
import { ErrorCodes } from '#common/error-codes.js';
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
    if (!principal) throw new UnauthorizedError(ErrorCodes.MISSING_AUTH);

    const ok = await this.repo.isSuperAdmin(principal.userId);
    if (!ok) throw new ForbiddenError(ErrorCodes.PERMISSION_DENIED, 'You do not have permission to perform this action');
    return true;
  }
}
