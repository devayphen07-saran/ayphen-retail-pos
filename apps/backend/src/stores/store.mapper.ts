import type { CreatedStore } from './store.service.js';
import type { StoreResponse } from './dto/store.response.js';

/** Pure domain → snake_case contract mapper (layered-architecture §3.7). */
export const StoreResponseMapper = {
  toResponse(s: CreatedStore): StoreResponse {
    return {
      id:   s.id,
      name: s.name,
    };
  },
};
