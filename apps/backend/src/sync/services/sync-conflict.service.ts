import { Injectable } from '@nestjs/common';
import { NotFoundError } from '#common/exceptions/app.exception.js';
import { ErrorCodes } from '#common/error-codes.js';
import {
  SyncConflictRepository,
  type SyncConflictRow,
  type ConflictStatus,
  type ConflictType,
} from '../repositories/sync-conflict.repository.js';

/** Conflict-resolution use cases (sync-engine.md §11) — bookkeeping only, the server never merges. */
@Injectable()
export class SyncConflictService {
  constructor(private readonly repo: SyncConflictRepository) {}

  async list(
    storeId: string,
    filter: { status?: ConflictStatus; conflictType?: ConflictType },
  ): Promise<SyncConflictRow[]> {
    return this.repo.list(storeId, filter);
  }

  async resolve(
    storeId: string,
    mutationId: string,
    patch: { status: 'resolved' | 'discarded'; note?: string; resolvedBy: string },
  ): Promise<SyncConflictRow> {
    const row = await this.repo.resolve(storeId, mutationId, patch);
    if (!row) {
      throw new NotFoundError(ErrorCodes.SYNC_CONFLICT_NOT_FOUND, 'No conflict recorded for this mutation');
    }
    return row;
  }
}
