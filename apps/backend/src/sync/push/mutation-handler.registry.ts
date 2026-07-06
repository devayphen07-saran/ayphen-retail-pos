import { Injectable } from '@nestjs/common';
import type { SyncMutationHandler } from './mutation.types.js';

/**
 * Entity→handler dispatch map (sync-engine.md §9 "Dispatcher, not a switch").
 * Constructed by the SyncModule factory with every registered handler; an
 * unknown entity_type is a per-mutation `rejected: UNKNOWN_MUTATION`, decided
 * by the pipeline, not here.
 */
@Injectable()
export class MutationHandlerRegistry {
  private readonly byType = new Map<string, SyncMutationHandler>();

  constructor(handlers: SyncMutationHandler[] = []) {
    for (const handler of handlers) {
      if (this.byType.has(handler.entityType)) {
        throw new Error(`[sync] duplicate mutation handler for '${handler.entityType}'`);
      }
      this.byType.set(handler.entityType, handler);
    }
  }

  get(entityType: string): SyncMutationHandler | undefined {
    return this.byType.get(entityType);
  }

  entityTypes(): string[] {
    return [...this.byType.keys()];
  }
}
