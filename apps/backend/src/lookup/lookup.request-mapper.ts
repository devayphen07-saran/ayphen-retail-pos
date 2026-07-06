import type {
  CreateLookupTypeDto,
  CreateLookupValueDto,
  UpdateLookupValueDto,
} from './dto/lookup.dto.js';

/** camelCase commands the LookupService consumes (layered-architecture §3.7). */
export interface CreateLookupTypeCommand {
  code:         string;
  title:        string;
  description?: string;
}

export interface CreateLookupValueCommand {
  code:         string;
  label:        string;
  description?: string;
  sortOrder?:   number;
}

export interface UpdateLookupValueCommand {
  label?:       string;
  description?: string;
  sortOrder?:   number;
  isHidden?:    boolean;
}

/**
 * Pure snake_case request DTO → camelCase command mapper. The only snake→camel
 * boundary for lookup writes — the service never reads request DTOs.
 */
export const LookupRequestMapper = {
  toCreateTypeCommand(dto: CreateLookupTypeDto): CreateLookupTypeCommand {
    return {
      code:        dto.code,
      title:       dto.title,
      description: dto.description,
    };
  },
  toCreateValueCommand(dto: CreateLookupValueDto): CreateLookupValueCommand {
    return {
      code:        dto.code,
      label:       dto.label,
      description: dto.description,
      sortOrder:   dto.sort_order,
    };
  },
  toUpdateValueCommand(dto: UpdateLookupValueDto): UpdateLookupValueCommand {
    return {
      label:       dto.label,
      description: dto.description,
      sortOrder:   dto.sort_order,
      isHidden:    dto.is_hidden,
    };
  },
};
