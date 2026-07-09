/** GET /stores/:storeId/setup-status response. snake_case wire contract. */
export interface SetupStatusResponse {
  total_checks:          number;
  completed_checks:      number;
  completion_percentage: number;
  status_map: {
    store_profile_complete: boolean;
    staff_invited:           boolean;
    product_added:           boolean;
    payment_configured:      boolean;
    device_linked:           boolean;
  };
}
