import { API } from '@ayphen/api-manager';
import { rethrowIfRateLimited } from './rate-limit-error';
import type {
  ChangesResult,
  ConflictResponse,
  InitialResult,
  SyncDeltaResult,
  SyncMutationInput,
} from './sync-wire-types';

/**
 * Raw calls to the sync engine's HTTP surface — bypasses TanStack Query and
 * api-manager's APIData/queryOptions convention on purpose, same as the
 * refresh/challenge calls in core/network/interceptors.ts: the sync engine is
 * driven by SyncScheduler on a timer/event, not a component's render lifecycle,
 * so there's no query cache to key it against.
 *
 * `SyncController` is annotated `@SkipTransform()` server-side — unlike most
 * endpoints, the response body IS the result shape directly, no
 * `{ success, data, ... }` envelope to unwrap (verified against
 * sync.controller.ts).
 */

function syncBase(storeId: string): string {
  return `stores/${storeId}/sync`;
}

export interface InitialParams {
  entityType?: string;
  cursor?: string;
  reset?: boolean;
  syncCursor?: string;
}

export async function pullInitial(
  storeId: string,
  supportedEntityTypes: string[],
  params: InitialParams,
): Promise<InitialResult> {
  try {
    const res = await API.get<InitialResult>(`${syncBase(storeId)}/initial`, {
      params: {
        entity_type: params.entityType,
        cursor: params.cursor,
        reset: params.reset ? 'true' : undefined,
        supported_entity_types: supportedEntityTypes.join(','),
        sync_cursor: params.syncCursor,
      },
    });
    return res.data;
  } catch (err) {
    rethrowIfRateLimited(err);
  }
}

export async function pullChanges(
  storeId: string,
  cursor: string,
  supportedEntityTypes: string[],
): Promise<ChangesResult> {
  try {
    const res = await API.get<ChangesResult>(`${syncBase(storeId)}/changes`, {
      params: { cursor, supported_entity_types: supportedEntityTypes.join(',') },
    });
    return res.data;
  } catch (err) {
    rethrowIfRateLimited(err);
  }
}

export interface PushDeltaBody {
  syncCursor?: string;
  permissionsVersion?: number;
  supportedEntityTypes: string[];
  mutations: SyncMutationInput[];
}

export async function pushDelta(storeId: string, body: PushDeltaBody): Promise<SyncDeltaResult> {
  try {
    const res = await API.post<SyncDeltaResult>(`${syncBase(storeId)}/delta`, {
      sync_cursor: body.syncCursor,
      permissions_version: body.permissionsVersion,
      supported_entity_types: body.supportedEntityTypes,
      mutations: body.mutations,
    });
    return res.data;
  } catch (err) {
    rethrowIfRateLimited(err);
  }
}

// NB: the backend also exposes `GET /sync/conflicts` (list). The mobile client
// deliberately does NOT call it — ConflictsScreen renders the local
// mutation_queue via useLiveQuery (offline-first; no redundant round trip), and
// resolveConflict below reports resolutions back best-effort. The list endpoint
// remains for a future admin/web surface; there is intentionally no client
// transport for it, rather than a dead unused one.

export async function resolveConflict(
  storeId: string,
  mutationId: string,
  patch: { status: 'resolved' | 'discarded'; note?: string },
): Promise<ConflictResponse> {
  try {
    const res = await API.patch<ConflictResponse>(`${syncBase(storeId)}/conflicts/${mutationId}`, patch);
    return res.data;
  } catch (err) {
    rethrowIfRateLimited(err);
  }
}
