import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DRIZZLE, type DbExecutor } from '#db/db.module.js';
import * as schema from '#db/schema.js';
import { entityTypes } from '#db/schema.js';

export interface EntityTypeRow {
  id:                   string;
  code:                 string;
  label:                string;
  isOfflineSafe:        boolean;
  supportsAttachments:  boolean;
}

/**
 * Wires the previously-orphaned `entity_types` table (lookup-entity-prd.md
 * §3.3, P0) — the polymorphic anchor registry that `files`/`notes`/`address`/
 * `communication`/`contact_person` attach to via `entity_type_fk`.
 */
@Injectable()
export class EntityTypesRepository {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>,
  ) {}

  private client(tx?: DbExecutor) {
    return tx ?? this.db;
  }

  async findByCode(code: string, tx?: DbExecutor): Promise<EntityTypeRow | null> {
    const [row] = await this.client(tx)
      .select()
      .from(entityTypes)
      .where(eq(entityTypes.code, code));
    return row ?? null;
  }

  /** Reverse lookup by id — resolves an `entity_type_fk` (e.g. from a `files`
   *  row) back to its code, used for per-parent-entity permission checks. */
  async findById(id: string, tx?: DbExecutor): Promise<EntityTypeRow | null> {
    const [row] = await this.client(tx)
      .select()
      .from(entityTypes)
      .where(eq(entityTypes.id, id));
    return row ?? null;
  }

  async listAll(tx?: DbExecutor): Promise<EntityTypeRow[]> {
    return this.client(tx).select().from(entityTypes);
  }

  async listOfflineSafe(tx?: DbExecutor): Promise<EntityTypeRow[]> {
    return this.client(tx)
      .select()
      .from(entityTypes)
      .where(eq(entityTypes.isOfflineSafe, true));
  }

  /** Whether the given entity code allows `files` rows (BR-7). */
  async supportsAttachments(code: string, tx?: DbExecutor): Promise<boolean> {
    const row = await this.findByCode(code, tx);
    return row?.supportsAttachments ?? false;
  }
}
