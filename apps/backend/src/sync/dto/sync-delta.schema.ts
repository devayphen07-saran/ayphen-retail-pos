import { z } from 'zod';
import { MAX_MUTATIONS_PER_BATCH } from '../sync.constants.js';

/** Client ULID idempotency key (Crockford base32, 26 chars). */
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/i;

export const MutationSchema = z.object({
  mutation_id: z.string().regex(ULID_RE, 'mutation_id must be a ULID'),
  entity_type: z.string().min(1).max(40),
  action: z.enum(['create', 'update', 'delete']),
  payload: z.record(z.string(), z.unknown()),
  /** REQUIRED for update — the optimistic lock (§11). Enforced in preflight, not here. */
  expected_row_version: z.number().int().positive().optional(),
  /** Queue time on the device — drives point-in-time grace + skew clamp (§12). */
  client_modified_at: z.iso.datetime({ offset: true }).optional(),
  /** Cascade-fail children when the parent fails (§9). */
  parent_guuid: z.uuid().optional(),
});

export type SyncMutation = z.infer<typeof MutationSchema>;

export const SyncDeltaSchema = z.object({
  sync_cursor: z.string().max(8192).optional(),
  permissions_version: z.number().int().optional(),
  supported_entity_types: z.array(z.string().max(40)).max(100).optional(),
  mutations: z.array(MutationSchema).max(MAX_MUTATIONS_PER_BATCH).default([]),
});

export type SyncDeltaRequest = z.infer<typeof SyncDeltaSchema>;

export const ChangesQuerySchema = z.object({
  cursor: z.string().min(1).max(8192),
  supported_entity_types: z.string().max(4096).optional(),
});

export const InitialQuerySchema = z.object({
  entity_type: z.string().max(40).optional(),
  cursor: z.string().max(512).optional(),
  reset: z.enum(['true', 'false']).optional(),
  supported_entity_types: z.string().max(4096).optional(),
  sync_cursor: z.string().max(8192).optional(),
});

export const ConflictListQuerySchema = z.object({
  status: z.enum(['open', 'resolved', 'discarded']).optional(),
  conflict_type: z.enum(['MASTER_DATA', 'VALIDATION', 'BUSINESS_RULE']).optional(),
});

export const ConflictResolveSchema = z.object({
  status: z.enum(['resolved', 'discarded']),
  note: z.string().max(500).optional(),
});