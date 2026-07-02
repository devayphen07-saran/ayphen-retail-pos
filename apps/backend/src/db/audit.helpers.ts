import type { RequestContextService } from '../auth/core/request-context.service.js';

export function auditInsert(ctx: RequestContextService, fallbackUserId?: string) {
  const now    = new Date();
  const userId = ctx.getUserId() ?? fallbackUserId ?? null;
  return { createdBy: userId, updatedBy: userId, createdAt: now, updatedAt: now };
}

export function auditUpdate(ctx: RequestContextService, fallbackUserId?: string) {
  return { updatedBy: ctx.getUserId() ?? fallbackUserId ?? null, updatedAt: new Date() };
}

export function auditDelete(ctx: RequestContextService, fallbackUserId?: string) {
  const userId = ctx.getUserId() ?? fallbackUserId ?? null;
  const now    = new Date();
  return { deletedBy: userId, deletedAt: now, updatedBy: userId, updatedAt: now };
}
