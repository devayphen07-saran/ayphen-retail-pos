import type { RequestContextService } from '#common/request-context/request-context.service.js';

/**
 * Audit-column stamps. `ctx` is OPTIONAL so cron jobs and seed scripts — which
 * run outside any request scope — can call the same repository methods; they
 * pass `undefined` (or a `fallbackUserId`) and the actor is recorded as null.
 */
interface InsertAudit { createdBy: string | null; updatedBy: string | null; createdAt: Date; updatedAt: Date }
interface UpdateAudit { updatedBy: string | null; updatedAt: Date }
interface DeleteAudit { deletedBy: string | null; deletedAt: Date; updatedBy: string | null; updatedAt: Date }

export function auditInsert(ctx?: RequestContextService, fallbackUserId?: string): InsertAudit {
  const now    = new Date();
  const userId = ctx?.getUserId() ?? fallbackUserId ?? null;
  return { createdBy: userId, updatedBy: userId, createdAt: now, updatedAt: now };
}

export function auditUpdate(ctx?: RequestContextService, fallbackUserId?: string): UpdateAudit {
  return { updatedBy: ctx?.getUserId() ?? fallbackUserId ?? null, updatedAt: new Date() };
}

export function auditDelete(ctx?: RequestContextService, fallbackUserId?: string): DeleteAudit {
  const userId = ctx?.getUserId() ?? fallbackUserId ?? null;
  const now    = new Date();
  return { deletedBy: userId, deletedAt: now, updatedBy: userId, updatedAt: now };
}