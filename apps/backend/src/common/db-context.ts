export function withAudit(userId: string) {
  return { createdBy: userId, updatedBy: userId };
}

export function withUpdatedBy(userId: string) {
  return { updatedBy: userId, updatedAt: new Date() };
}

export function withSoftDelete(userId: string) {
  return { deletedAt: new Date(), deletedBy: userId, updatedBy: userId };
}
