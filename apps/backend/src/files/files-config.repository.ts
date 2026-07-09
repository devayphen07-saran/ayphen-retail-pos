import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DRIZZLE, type DbExecutor } from '#db/db.module.js';
import * as schema from '#db/schema.js';
import { filesConfig } from '#db/schema.js';

/** A resolved upload rule (table-architecture §33.3) driving BR1–BR4. */
export interface FileConfigRule {
  id:                     string;
  entityTypeFk:           string;
  fileKind:               string | null;
  maxFileSizeBytes:       number;
  maxConsolidatedSizeBytes: number;
  validExtensions:        string[]; // parsed from the comma list
  maxAttachmentsAllowed:  number;
}

@Injectable()
export class FilesConfigRepository {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>,
  ) {}

  private client(tx?: DbExecutor) {
    return tx ?? this.db;
  }

  /**
   * Resolve the rule for `(entityTypeFk, kind)`. A kind-specific active rule
   * wins; otherwise the entity-wide rule (`file_kind IS NULL`) applies. Returns
   * null when neither exists — the caller rejects the upload (fail-closed).
   */
  async findRule(entityTypeFk: string, kind: string, tx?: DbExecutor): Promise<FileConfigRule | null> {
    const rows = await this.client(tx)
      .select()
      .from(filesConfig)
      .where(and(eq(filesConfig.entityTypeFk, entityTypeFk), eq(filesConfig.isActive, true)));

    const specific = rows.find((r) => r.fileKind === kind);
    const entityWide = rows.find((r) => r.fileKind === null);
    const row = specific ?? entityWide;
    return row ? this.toRule(row) : null;
  }

  private toRule(row: typeof filesConfig.$inferSelect): FileConfigRule {
    return {
      id:                       row.id,
      entityTypeFk:             row.entityTypeFk,
      fileKind:                 row.fileKind,
      maxFileSizeBytes:         row.maxFileSizeBytes,
      maxConsolidatedSizeBytes: row.maxConsolidatedSizeBytes,
      validExtensions:          row.validExtensions
        .split(',')
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean),
      maxAttachmentsAllowed:    row.maxAttachmentsAllowed,
    };
  }
}
