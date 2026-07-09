import type { CreatedStore, SetupStatus } from './store.service.js';
import type { StoreResponse } from './dto/store.response.js';
import type { SetupStatusResponse } from './dto/setup-status.response.js';

/** Pure domain → snake_case contract mapper (layered-architecture §3.7). */
export const StoreResponseMapper = {
  toResponse(s: CreatedStore): StoreResponse {
    return {
      id: s.id,
      name: s.name,
      snapshot: s.snapshot,
      snapshot_signature: s.snapshotSignature,
    };
  },

  toSetupStatus(s: SetupStatus): SetupStatusResponse {
    return {
      total_checks: s.totalChecks,
      completed_checks: s.completedChecks,
      completion_percentage: s.completionPercentage,
      status_map: {
        store_profile_complete: s.statusMap.storeProfileComplete,
        staff_invited: s.statusMap.staffInvited,
        product_added: s.statusMap.productAdded,
        payment_configured: s.statusMap.paymentConfigured,
        device_linked: s.statusMap.deviceLinked,
      },
    };
  },
};
