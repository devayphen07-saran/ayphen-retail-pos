import type {
  CreateLookupTypeCommand,
  CreateLookupValueCommand,
  UpdateLookupValueCommand,
} from './lookup.service.js';
import type {
  CreateLookupTypeDto,
  CreateLookupValueDto,
  UpdateLookupValueDto,
} from './dto/lookup.dto.js';

/**
 * The only inbound translation point for lookup writes: snake_case wire DTO →
 * camelCase domain command. Pure, no DI, no async (§3.3). Previously the
 * controllers did this reshaping inline (`sort_order` → `sortOrder`,
 * `is_hidden` → `isHidden`, `expected_row_version` → `expectedRowVersion`),
 * which put the mapper's job in the controller.
 */
export const LookupRequestMapper = {
  toCreateTypeCommand(dto: CreateLookupTypeDto): CreateLookupTypeCommand {
    return {
      code: dto.code,
      title: dto.title,
      description: dto.description,
    };
  },

  toCreateValueCommand(dto: CreateLookupValueDto): CreateLookupValueCommand {
    return {
      code: dto.code,
      label: dto.label,
      description: dto.description,
      sortOrder: dto.sort_order,
    };
  },

  toUpdateValueCommand(dto: UpdateLookupValueDto): UpdateLookupValueCommand {
    return {
      label: dto.label,
      description: dto.description,
      sortOrder: dto.sort_order,
      isHidden: dto.is_hidden,
      expectedRowVersion: dto.expected_row_version,
    };
  },
};