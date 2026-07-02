import { Global, Module } from '@nestjs/common';
import { RbacMatrixValidatorService } from './rbac-matrix.validator.service.js';
import { RbacRepository } from './rbac.repository.js';
import { RbacService } from './rbac.service.js';
import { TenantGuard } from './guards/tenant.guard.js';
import { PermissionsGuard } from './guards/permissions.guard.js';
import { SuperAdminGuard } from './guards/super-admin.guard.js';
import { StepUpAuthGuard } from './guards/step-up-auth.guard.js';
import { LocationGuard } from './guards/location.guard.js';

/**
 * RBAC foundation module (rbac.md §5, §10–13, §15–17, §21). Validates the
 * permission matrix at startup, provides the RBAC service + repository, and the
 * enforcement guards. MOBILE_REDIS comes from RedisModule; AuditService/
 * CryptoService from the global AuthCoreModule. Route-config validation lives in
 * the separate RbacRouteValidatorModule (it needs DiscoveryModule, which must
 * not sit in this early-loading global module — see that module's note).
 */
@Global()
@Module({
  providers: [
    RbacMatrixValidatorService,
    RbacRepository,
    RbacService,
    TenantGuard,
    PermissionsGuard,
    SuperAdminGuard,
    StepUpAuthGuard,
    LocationGuard,
  ],
  exports: [
    RbacService,
    RbacRepository,
    TenantGuard,
    PermissionsGuard,
    SuperAdminGuard,
    StepUpAuthGuard,
    LocationGuard,
  ],
})
export class RbacModule {}
