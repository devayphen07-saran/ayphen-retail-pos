import type { Location } from './location.repository.js';

export interface LocationResponse {
  id:            string;
  name:          string;
  is_primary:    boolean;   // Head Office
  is_default:    boolean;
  enable:        boolean;
  is_locked:     boolean;   // downgrade-locked
  display_order: number;
}

/** Pure domain → snake_case mapper (layered-architecture §3.7). */
export const LocationMapper = {
  toResponse(l: Location): LocationResponse {
    return {
      id:            l.id,
      name:          l.name,
      is_primary:    l.isPrimary,
      is_default:    l.isDefault,
      enable:        l.enable,
      is_locked:     l.locked,
      display_order: l.displayOrder,
    };
  },
  toList(rows: Location[]): LocationResponse[] {
    return rows.map((l) => LocationMapper.toResponse(l));
  },
};
