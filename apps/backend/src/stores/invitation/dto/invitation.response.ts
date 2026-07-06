/** Wire contracts for invitation endpoints (snake_case). Leaf node — imports nothing. */

export interface MyInvitationResponse {
  id:         string;
  store_id:   string;
  store_name: string;
  role_name:  string;
  expires_at: string;
}

/** Wire shape for accept/acceptById — the store the caller just joined. */
export interface AcceptInvitationResponse {
  store_id: string;
}