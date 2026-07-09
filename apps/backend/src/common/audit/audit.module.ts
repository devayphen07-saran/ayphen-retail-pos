import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service.js';

/** SOC2-style audit-log writer, shared app-wide across auth/rbac/stores/subscription/devices. */
@Global()
@Module({
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
