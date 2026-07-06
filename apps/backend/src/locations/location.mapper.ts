import type { LocationResult } from './location.service.js';
import type { LocationMember } from './user-location.repository.js';

export interface LocationResponse {
  id:            string;
  name:          string;
  is_primary:    boolean;   // Head Office
  is_default:    boolean;
  enable:        boolean;
  is_locked:     boolean;   // downgrade-locked
  display_order: number;
}

export interface LocationMemberResponse {
  user_id:     string;
  user_name:   string;
  assigned_at: string;
}

/** Pure domain → snake_case mapper (layered-architecture §3.7). */
export const LocationMapper = {
  toResponse(l: LocationResult): LocationResponse {
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
  toList(rows: LocationResult[]): LocationResponse[] {
    return rows.map((l) => LocationMapper.toResponse(l));
  },
  toMemberResponse(m: LocationMember): LocationMemberResponse {
    return {
      user_id:     m.userId,
      user_name:   m.userName,
      assigned_at: m.assignedAt.toISOString(),
    };
  },
  toMemberList(rows: LocationMember[]): LocationMemberResponse[] {
    return rows.map((m) => LocationMapper.toMemberResponse(m));
  },
};