import type { CommitFilesDto } from './dto/commit-files.request.js';
import type { CommitFilesCommand } from './files.service.js';

/**
 * Request mapper (§3.3) — the single inbound snake_case → camelCase translation
 * for `POST /files/commit`. Pure function, no DI/async. Symmetric with the
 * response mapper in `files.mapper.ts`.
 */
export const CommitFilesRequestMapper = {
  toCommand(dto: CommitFilesDto): CommitFilesCommand {
    return {
      entityType:  dto.entity_type,
      recordGuuid: dto.record_guuid,
      recordId:    dto.record_id ?? null,
      kind:        dto.kind,
      fileGuuids:  dto.file_guuids,
      description: dto.description ?? null,
    };
  },
};
