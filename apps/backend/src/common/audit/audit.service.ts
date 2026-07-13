import { Inject, Injectable } from '@nestjs/common';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DRIZZLE, type DbTransaction } from '#db/db.module.js';
import * as schema from '#db/schema.js';
import { auditLogs } from '#db/schema.js';

export type ActivityType =
  | 'AUTH_LOGIN'
  | 'AUTH_LOGOUT'
  | 'AUTH_SIGNUP'
  | 'AUTH_STEP_UP'
  | 'AUTH_PASSWORD_RESET'
  | 'SESSION_REVOKED'
  | 'DEVICE_BLOCKED'
  | 'OTP_SENT'
  | 'OTP_VERIFIED'
  | 'PERMISSION_CHANGED'
  | 'ACCOUNT_LOCKED'
  // ─ RBAC audit events (§20) ─
  | 'PERMISSION_DENIED'
  | 'SPECIAL_PERMISSION_DENIED'
  | 'ROLE_PERMISSION_CHANGED'
  | 'ROLE_ASSIGNMENT_CREATED'
  | 'ROLE_ASSIGNMENT_REVOKED'
  | 'INVITATION_CREATED'
  // ─ Billing / subscription events (subscription §29.14) ─
  | 'SUBSCRIPTION_CHANGED'
  // ─ Lookup engine events (lookup-entity-prd.md §6/§9) ─
  | 'LOOKUP_CHANGED'
  // ─ Tax-rate config events (online-only, server-authoritative) ─
  | 'TAXRATE_CHANGED';

export interface AuditLogEntry {
  event:        string;
  activityType: ActivityType;
  prefix:       string;
  suffix:       string;
  userId:       string;
  actorId?:     string;
  storeFk?:     string;   // §20 — store scope for RBAC denials
  isSuccess?:   boolean;  // defaults true; false = denial (SOC2 CC6.3)
  entityType?:  string;
  entityId?:    string;
  metadata?:    Record<string, unknown>;
  ipAddress?:   string;
  userAgent?:   string;
}

@Injectable()
export class AuditService {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>,
  ) {}

  async log(entry: AuditLogEntry): Promise<void> {
    await this.db.insert(auditLogs).values(this.toRow(entry));
  }

  async logInTransaction(entry: AuditLogEntry, tx: DbTransaction): Promise<void> {
    await tx.insert(auditLogs).values(this.toRow(entry));
  }

  private toRow(entry: AuditLogEntry) {
    return {
      event:        entry.event,
      activityType: entry.activityType,
      prefix:       entry.prefix,
      suffix:       entry.suffix,
      userId:       entry.userId,
      actorId:      entry.actorId,
      storeFk:      entry.storeFk,
      isSuccess:    entry.isSuccess ?? true,
      entityType:   entry.entityType,
      entityId:     entry.entityId,
      metadata:     entry.metadata ?? {},
      ipAddress:    entry.ipAddress,
      userAgent:    entry.userAgent,
    };
  }
}
