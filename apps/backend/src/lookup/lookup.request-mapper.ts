import type {
  CreateLookupTypeDto,
  CreateLookupValueDto,
  UpdateLookupValueDto,
} from './dto/lookup.dto.js';
import type {
  CreateLookupTypeCommand,
  CreateLookupValueCommand,
  UpdateLookupValueCommand,
} from './lookup.service.js';

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
