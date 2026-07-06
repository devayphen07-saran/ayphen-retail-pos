export interface ConflictResponse {
  mutation_id: string;
  entity_type: string;
  entity_guuid: string | null;
  conflict_type: string;
  server_row: unknown;
  client_payload: unknown;
  message: string | null;
  status: string;
  note: string | null;
  created_at: string;
  resolved_at: string | null;
}

export interface ConflictListResponse {
  conflicts: ConflictResponse[];
}
