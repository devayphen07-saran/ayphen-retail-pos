import { useQuery } from '@tanstack/react-query';
import { GET_ENTITY_TYPES } from './api-data';
import type { EntityTypeResponse } from './types';

export const entityTypeKeys = {
  all: ['entity-types'] as const,
};

/** Static reference data — cache for the session, it never changes at runtime. */
export const useEntityTypesQuery = (options?: { enabled?: boolean }) =>
  useQuery({
    ...GET_ENTITY_TYPES.queryOptions<EntityTypeResponse[]>(),
    queryKey: entityTypeKeys.all,
    enabled: options?.enabled ?? true,
    staleTime: 24 * 60 * 60 * 1000,
  });
