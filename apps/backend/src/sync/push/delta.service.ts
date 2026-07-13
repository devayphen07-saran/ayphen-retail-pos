import { Injectable, Logger } from '@nestjs/common';
import { UnitOfWork, type DbTransaction } from '#db/db.module.js';
import { unwrapPgError } from '#db/rethrow-unique-violation.js';
import { SubscriptionRepository, type SubscriptionSyncState } from '../../subscription/subscription.repository.js';
import { ErrorCodes, type ErrorCode } from '#common/error-codes.js';
import { ServiceUnavailableError } from '#common/exceptions/app.exception.js';
import { parse } from '#common/validation/parse.js';
import { RbacService } from '#common/rbac/rbac.service.js';
import { RbacRepository } from '#common/rbac/rbac.repository.js';
import type { CrudAction } from '#common/rbac/permission-matrix.constants.js';
import type { EffectivePermissions } from '#common/rbac/effective-permissions.js';
import type { MobilePrincipal } from '#common/types/principal.js';
import { AuthSessionRepository } from '#auth/mobile/repositories/auth-session.repository.js';
import { SnapshotService } from '#auth/mobile/services/snapshot.service.js';
import { SyncChangesService, type ChangesResult } from '../pull/changes.service.js';
import { SyncCursorService } from '../cursor/sync-cursor.service.js';
import { SyncIdempotencyRepository } from '../repositories/sync-idempotency.repository.js';
import { SyncMutationFailureRepository } from '../repositories/sync-mutation-failure.repository.js';
import { SyncConflictRepository, type ConflictType } from '../repositories/sync-conflict.repository.js';
import { DeviceSyncHealthRepository } from '../repositories/device-sync-health.repository.js';
import { MutationHandlerRegistry } from './mutation-handler.registry.js';
import type { HandlerOutcome, SyncMutationHandler } from './mutation.types.js';
import { SyncDeltaSchema, type SyncDeltaRequest, type SyncMutation } from '../dto/sync-delta.schema.js';
import {
  FUTURE_SKEW_TOLERANCE_MS,
  IDEMPOTENCY_RACE_POLL_INTERVAL_MS,
  IDEMPOTENCY_RACE_POLL_TIMEOUT_MS,
  MAX_MUTATION_PAYLOAD_BYTES,
  POISON_MUTATION_MAX_FAILURES,
  REVOCATION_GRACE_WINDOW_MS,
  WAVE_CONCURRENCY,
} from '../sync.constants.js';
import { runBounded } from '../bounded.js';

// ─── Wire shapes (§9 response) ────────────────────────────────────────────────

export type MutationResultWire =
  | { mutation_id: string; status: 'applied'; entity_id?: string; entity_guuid?: string; row_version?: number; data?: unknown }
  | { mutation_id: string; status: 'duplicate'; cached: unknown }
  | { mutation_id: string; status: 'rejected'; code: ErrorCode; message: string; conflict_type?: ConflictType }
  // A TRANSIENT block (subscription paused / reconciliation pending / not yet
  // loaded). Distinct from `rejected` on purpose: the server does NOT cache it
  // (the state can heal), so the CLIENT must keep the mutation queued and
  // re-push later — NEVER roll it back like a terminal `rejected` (a sale rung
  // during a lapse-then-renew would otherwise be silently lost). See §20/F2.
  | { mutation_id: string; status: 'retry_later'; code: ErrorCode; message: string; conflict_type?: ConflictType }
  | { mutation_id: string; status: 'conflict'; conflict_type: 'MASTER_DATA'; server_row: unknown; message: string };

export interface SyncDeltaResult {
  mutation_results: MutationResultWire[];
  changes: ChangesResult['changes'];
  sync_cursor: string | null;
  has_more: boolean;
  server_time: string;
  permissions_version: number;
  snapshot?: unknown;
  snapshot_signature?: string;
}

// ─── Internal signals ─────────────────────────────────────────────────────────

/** Handler returned `rejected` — abort the business tx (nothing may persist). */
class HandlerRejectedSignal extends Error {
  constructor(readonly outcome: Extract<HandlerOutcome, { kind: 'rejected' }>) {
    super('handler rejected');
  }
}

/** A concurrent identical mutation won the idempotency insert — roll back and poll. */
class RaceLostSignal extends Error {}

interface MutationEnv {
  now: Date;
  storeId: string;
  userId: string;
  deviceId: string;
  sessionCreatedAt: Date;
  /** This device's PRIOR sync (C1) — floors the subscription write-gate below. */
  deviceLastSyncAt: Date | null;
  permissions: EffectivePermissions;
  subscription: SubscriptionSyncState | null;
  failedGuuids: Set<string>;
}

const CRUD_BY_ACTION: Record<SyncMutation['action'], CrudAction> = {
  create: 'create',
  update: 'edit',
  delete: 'delete',
};

/**
 * The combined push+pull endpoint (sync-engine.md §9). Per-mutation
 * transactions — mutation #5 failing rolls back only #5. Preflight order is
 * normative: idempotency dedupe → skew clamp → poison cap → parent cascade →
 * handler-exists → row-version-required → authorization (current, then
 * point-in-time grace §12) → subscription point-in-time gate (§20).
 */
@Injectable()
export class SyncDeltaService {
  private readonly logger = new Logger(SyncDeltaService.name);

  constructor(
    private readonly subscriptions: SubscriptionRepository,
    private readonly uow: UnitOfWork,
    private readonly handlers: MutationHandlerRegistry,
    private readonly idempotency: SyncIdempotencyRepository,
    private readonly failures: SyncMutationFailureRepository,
    private readonly conflicts: SyncConflictRepository,
    private readonly rbac: RbacService,
    private readonly rbacRepo: RbacRepository,
    private readonly sessions: AuthSessionRepository,
    private readonly snapshots: SnapshotService,
    private readonly changes: SyncChangesService,
    private readonly cursors: SyncCursorService,
    private readonly health: DeviceSyncHealthRepository,
  ) {}

  async process(
    principal: MobilePrincipal,
    store: { storeId: string; accountId: string },
    rawBody: unknown,
  ): Promise<SyncDeltaResult> {
    const body = parse(rawBody, SyncDeltaSchema);
    const now = new Date();

    // Validate the pull cursor BEFORE applying anything: an invalid/horizon
    // cursor must 400/410 up front, not after half the batch committed (the
    // client would retry the whole call and every result must replay cleanly).
    if (body.sync_cursor) {
      this.cursors.decode(body.sync_cursor, principal.userId, store.storeId, now);
    }

    const env = await this.loadMutationEnv(principal, store, now);
    const results = await this.runMutationWaves(body.mutations, env);

    return this.buildResult(principal, body, env, results);
  }

  /** Assemble the per-request preflight context every mutation is checked
   *  against: session floor, subscription snapshot, and current permissions. */
  private async loadMutationEnv(
    principal: MobilePrincipal,
    store: { storeId: string; accountId: string },
    now: Date,
  ): Promise<MutationEnv> {
    const { storeId, accountId } = store;
    const userId = principal.userId;

    const session = await this.sessions.findById(principal.deviceSessionId);
    const sessionCreatedAt: Date = session?.createdAt ?? now;

    const sub = await this.subscriptions.findSyncStateByAccount(accountId);

    // Read BEFORE buildResult's touch() stamps the new value — this is the
    // device's prior server contact, the C1 subscription-gate floor.
    const deviceLastSyncAt = await this.health.getLastSyncAt(principal.deviceId);

    const permissions = await this.rbac.getCachedPermissions(userId, storeId, true);

    return {
      now,
      storeId,
      userId,
      deviceId: principal.deviceId,
      sessionCreatedAt,
      deviceLastSyncAt,
      permissions,
      subscription: sub,
      failedGuuids: new Set<string>(),
    };
  }

  /**
   * Dependency-sort so a parent in the same batch always applies before its
   * children regardless of client ordering (S-3a), dedupe repeated
   * mutation_ids, then run independent mutations concurrently within a
   * "wave": a mutation always lands in a strictly later wave than its parent
   * AND than any earlier mutation touching the same entity guuid —
   * preserving both S-3a/S-3b cascade ordering and same-entity mutation
   * ordering while letting a large batch of unrelated mutations avoid paying
   * N sequential round trips. Mutates env.failedGuuids as cascade-relevant
   * failures land, for later mutations in the same batch to check.
   */
  private async runMutationWaves(
    mutations: SyncMutation[],
    env: MutationEnv,
  ): Promise<Map<string, MutationResultWire>> {
    const results = new Map<string, MutationResultWire>();

    // Reject parent_guuid cycles deterministically (C3) BEFORE sorting, so a
    // dependency loop can't silently apply a child before its parent. Each
    // cycle member's guuid also joins failedGuuids, so any non-cyclic child
    // hanging off the loop cascades to PARENT_FAILED below.
    const cyclic = findParentCycleMutationIds(mutations);
    for (const m of mutations) {
      if (!cyclic.has(m.mutation_id)) continue;
      results.set(m.mutation_id, {
        mutation_id: m.mutation_id,
        status: 'rejected',
        // Uncached (unlike terminalReject): a cycle is a property of THIS
        // batch's shape — resubmitting the same mutation without the loop must
        // be free to succeed, not replay a stale `duplicate`.
        code: ErrorCodes.PARENT_CYCLE,
        message: 'parent_guuid forms a dependency cycle — resubmit without the loop',
        conflict_type: 'VALIDATION',
      });
      const guuid = typeof m.payload.guuid === 'string' ? m.payload.guuid : undefined;
      if (guuid) env.failedGuuids.add(guuid);
    }

    const sorted = topoSort(mutations.filter((m) => !cyclic.has(m.mutation_id)));

    // Duplicate mutation_id in one batch — first occurrence wins; later ones
    // are pure resubmits and resolve to the same Map entry with no extra work.
    const seenIds = new Set<string>();
    const unique = sorted.filter((m) => {
      if (seenIds.has(m.mutation_id)) return false;
      seenIds.add(m.mutation_id);
      return true;
    });

    for (const wave of computeWaves(unique)) {
      const waveResults = await runBounded(wave, WAVE_CONCURRENCY, (m) => this.processOne(m, env));
      wave.forEach((mutation, i) => {
        const result = waveResults[i]!;
        results.set(mutation.mutation_id, result);

        const guuid = typeof mutation.payload.guuid === 'string' ? mutation.payload.guuid : undefined;
        const failed =
          result.status === 'rejected' ||
          result.status === 'conflict' ||
          // A parent rejected on a PRIOR batch replays as duplicate{cached:rejected}
          // — it must still cascade (S-3b).
          (result.status === 'duplicate' &&
            (result.cached as { status?: string } | null)?.status === 'rejected');
        if (failed && guuid) env.failedGuuids.add(guuid);
      });
    }

    return results;
  }

  /** Stamps device sync health, folds in the pull-side changes for this
   *  cursor (if any), and assembles the wire response. */
  private async buildResult(
    principal: MobilePrincipal,
    body: SyncDeltaRequest,
    env: MutationEnv,
    results: Map<string, MutationResultWire>,
  ): Promise<SyncDeltaResult> {
    // Stamp device sync health — S-34's `min(last_sync_at)` oversell gate reads
    // this. Shared with the pull/initial paths so a pull-only device still
    // advances the watermark (F1).
    await this.health.touch(principal.deviceId, env.now);

    let pulled: ChangesResult | null = null;
    if (body.sync_cursor) {
      const supported = body.supported_entity_types;
      pulled = await this.changes.pull(principal.userId, env.storeId, body.sync_cursor, supported);
    }

    // Permission-freshness piggyback — same contract as the auth endpoints:
    // null means the client's snapshot version is current.
    const snapshot = await this.snapshots.getOrBuild(principal.userId, body.permissions_version);

    return {
      mutation_results: body.mutations.map((m) => results.get(m.mutation_id)!),
      changes: pulled?.changes ?? {},
      sync_cursor: pulled?.sync_cursor ?? null,
      has_more: pulled?.has_more ?? false,
      server_time: env.now.toISOString(),
      permissions_version: principal.permissionsVersion,
      ...(snapshot ? { snapshot: snapshot.snapshot, snapshot_signature: snapshot.signature } : {}),
    };
  }

  // ─── One mutation through the full preflight + tx (§9 submit loop) ──────────

  private async processOne(m: SyncMutation, env: MutationEnv): Promise<MutationResultWire> {
    // 1. Idempotency dedupe FIRST (before any tx, and before the payload-cap
    //    check below) so a retry of an already-decided mutation replays its
    //    cached result as `duplicate` rather than re-deriving a fresh outcome
    //    (F4). Expired rows are dropped so the in-tx claim can legitimately
    //    re-insert (§10 read-time TTL).
    const existing = await this.idempotency.find(m.mutation_id, env.userId, env.storeId);
    if (existing) {
      if (this.idempotency.isLive(existing, env.now)) {
        const cached = existing.result as Record<string, unknown>;
        const sanitized =
          existing.status === 'conflict' ? { ...cached, server_row: undefined } : cached;
        return { mutation_id: m.mutation_id, status: 'duplicate', cached: sanitized };
      }
      await this.idempotency.remove(m.mutation_id, env.userId, env.storeId);
    }

    // 1b. Per-mutation payload cap (S-36) — deterministic → cached; on retry the
    //     idempotency check above short-circuits to `duplicate` first.
    if (Buffer.byteLength(JSON.stringify(m.payload)) > MAX_MUTATION_PAYLOAD_BYTES) {
      return this.terminalReject(m, env, ErrorCodes.MUTATION_PAYLOAD_TOO_LARGE,
        'mutation payload exceeds the per-mutation size cap — split it client-side', 'VALIDATION');
    }

    // 2. Poison cap (S-7) — never re-run a permanently failing handler forever.
    const failureCount = await this.failures.count(m.mutation_id, env.userId, env.storeId);
    if (failureCount >= POISON_MUTATION_MAX_FAILURES) {
      return this.terminalReject(m, env, ErrorCodes.SERVER_ERROR,
        `mutation permanently failed after ${failureCount} attempts`, 'BUSINESS_RULE');
    }

    // 3. Parent cascade — env.failedGuuids already includes cached-rejected
    //    parents from this batch (S-3b).
    if (m.parent_guuid && env.failedGuuids.has(m.parent_guuid)) {
      return this.terminalReject(m, env, ErrorCodes.PARENT_FAILED,
        'parent mutation failed — resubmit after fixing the parent', 'BUSINESS_RULE');
    }

    // 4. Skew CLAMP (§12 layer 1, S-24): a clock-fast device's honest sale is
    //    applied at server-now, never rejected. Rejection is reserved for
    //    privilege, not honesty.
    const rawClientAt = m.client_modified_at ? new Date(m.client_modified_at) : null;
    const clientAt = rawClientAt && !Number.isNaN(rawClientAt.getTime()) ? rawClientAt : null;
    const effectiveAsOf = clientAt && clientAt < env.now ? clientAt : env.now;

    // 5. Handler exists (registry dispatch, no switch).
    const handler = this.handlers.get(m.entity_type);
    if (!handler) {
      return this.terminalReject(m, env, ErrorCodes.UNKNOWN_MUTATION,
        `no mutation handler registered for '${m.entity_type}'`, 'VALIDATION');
    }

    // 6. Optimistic lock is mandatory for updates (§11).
    if (m.action === 'update' && m.expected_row_version == null) {
      return this.terminalReject(m, env, ErrorCodes.SYNC_MISSING_ROW_VERSION,
        'update requires expected_row_version', 'VALIDATION');
    }

    // 7. Authorization: current permissions, else point-in-time grace (§12).
    const crudAction = CRUD_BY_ACTION[m.action];
    if (!this.rbac.checkCrud(env.permissions, handler.permissionEntity, crudAction)) {
      const denial = await this.checkGrace(m, handler, clientAt, effectiveAsOf, crudAction, env);
      if (denial) return denial;
    }

    // 8. Subscription point-in-time write-gate (§20 — the §12 pattern against
    //    access_valid_until, with the billing grace already folded into that column).
    const subDenial = await this.checkSubscription(m, effectiveAsOf, env);
    if (subDenial) return subDenial;

    // 9. The business transaction.
    return this.execute(m, handler, effectiveAsOf, env);
  }

  /** Point-in-time grace (§12): authorized at queue time still applies — with
   *  the three-layer backdate defense (strict future reject INSIDE grace,
   *  session floor, 30-min reach-back clamp). */
  private async checkGrace(
    m: SyncMutation,
    handler: SyncMutationHandler,
    clientAt: Date | null,
    effectiveAsOf: Date,
    crudAction: CrudAction,
    env: MutationEnv,
  ): Promise<MutationResultWire | null> {
    const deny = (message: string) =>
      this.terminalReject(m, env, ErrorCodes.PERMISSION_DENIED, message, 'BUSINESS_RULE');

    if (!clientAt) return deny('not authorized (no queue-time timestamp for grace)');
    // Backdating/forward-dating grants privilege here — stay strict (§12 layer 2).
    if (clientAt.getTime() > env.now.getTime() + FUTURE_SKEW_TOLERANCE_MS) {
      return deny('not authorized (client_modified_at is in the future)');
    }
    // A mutation cannot predate its own device session (§12 layer 3).
    if (clientAt < env.sessionCreatedAt) {
      return deny('not authorized (mutation predates its device session)');
    }

    const graceFloor = new Date(env.now.getTime() - REVOCATION_GRACE_WINDOW_MS);
    const graceAsOf = effectiveAsOf > graceFloor ? effectiveAsOf : graceFloor;

    const wasAuthorized = await this.rbacRepo.wasCrudAuthorizedAt({
      userId: env.userId,
      storeId: env.storeId,
      entity: handler.permissionEntity,
      action: crudAction,
      asOf: graceAsOf,
    });
    return wasAuthorized ? null : deny('not authorized (revoked before this write was queued)');
  }

  /** §20 write-gate: offline writes stamped before access_valid_until apply;
   *  later ones are SUBSCRIPTION_LAPSED_AT_WRITE. Transient states (paused,
   *  pending reconciliation) reject WITHOUT caching — they can heal. */
  private async checkSubscription(
    m: SyncMutation,
    effectiveAsOf: Date,
    env: MutationEnv,
  ): Promise<MutationResultWire | null> {
    const sub = env.subscription;
    if (!sub) {
      return this.retryLater(m, ErrorCodes.SUBSCRIPTION_NOT_FOUND, 'no subscription for this account');
    }
    if (sub.status === 'paused') {
      return this.retryLater(m, ErrorCodes.SUBSCRIPTION_SUSPENDED, 'account is suspended');
    }
    if (
      sub.reconciliationStatus === 'pending' &&
      !(sub.reconciliationEffectiveAt && effectiveAsOf < sub.reconciliationEffectiveAt)
    ) {
      return this.retryLater(
        m,
        ErrorCodes.SUBSCRIPTION_RECONCILIATION_REQUIRED,
        'a plan downgrade is awaiting reconciliation',
      );
    }
    // Floor the effective stamp (C1). Two server-trusted lower bounds neither of
    // which a client can forge:
    //  - sessionCreatedAt: a mutation cannot predate its own device session
    //    (mirrors §12 layer 3 in checkGrace).
    //  - deviceLastSyncAt: this device's PRIOR server contact. A device that was
    //    demonstrably online (synced) after the subscription lapsed cannot then
    //    claim writes stamped before the lapse — the app's local gate blocks new
    //    sales once access_valid_until passes, so no legitimately-unpushed
    //    pre-lapse write survives a later sync. Genuine offline sales are always
    //    stamped AFTER the device's last sync, so this floor never rejects them.
    // Together these stop a raw API client (bypassing the app) from pinning
    // client_modified_at before access_valid_until to evade the gate forever.
    // The residual — pinning within the window between last sync and lapse —
    // needs the signed access_valid_until hardening tracked as planned
    // (subscription.md §23, Rec7).
    let subAsOf = effectiveAsOf > env.sessionCreatedAt ? effectiveAsOf : env.sessionCreatedAt;
    if (env.deviceLastSyncAt && env.deviceLastSyncAt > subAsOf) {
      subAsOf = env.deviceLastSyncAt;
    }
    if (
      sub.accessValidUntil &&
      env.now > sub.accessValidUntil &&
      subAsOf > sub.accessValidUntil
    ) {
      // Deterministic for this stamp — cache it (a renewal can't retro-authorize
      // a write made after the window closed).
      return this.terminalReject(m, env, ErrorCodes.SUBSCRIPTION_LAPSED_AT_WRITE,
        'write was queued after the subscription lapsed', 'BUSINESS_RULE');
    }
    return null;
  }

  // ─── Business tx: savepoint → handler → conflict row → same-tx idempotency ──

  private async execute(
    m: SyncMutation,
    handler: SyncMutationHandler,
    effectiveAsOf: Date,
    env: MutationEnv,
  ): Promise<MutationResultWire> {
    try {
      return await this.uow.execute(async (tx) => {
        const outcome = await this.runHandlerInSavepoint(tx, m, handler, effectiveAsOf, env);

        if (outcome.kind === 'rejected') throw new HandlerRejectedSignal(outcome);

        const wire = this.toWire(m, outcome);

        if (outcome.kind === 'conflict') {
          await this.conflicts.record(
            {
              mutationId: m.mutation_id,
              userFk: env.userId,
              storeFk: env.storeId,
              entityType: m.entity_type,
              entityGuuid: outcome.entityGuuid,
              conflictType: 'MASTER_DATA',
              serverRow: outcome.serverRow,
              clientPayload: m.payload,
              message: outcome.message,
            },
            tx,
          );
        }

        // THE invariant (§10): the idempotency row commits with the business
        // write or not at all — a crash between them is impossible.
        const claimed = await this.idempotency.claim(tx, {
          mutationId: m.mutation_id,
          userFk: env.userId,
          storeFk: env.storeId,
          entityType: m.entity_type,
          action: m.action,
          status: outcome.kind === 'applied' ? 'applied' : 'conflict',
          result: wire,
        });
        if (!claimed) throw new RaceLostSignal();

        return wire;
      });
    } catch (error) {
      return this.mapExecuteFailure(error, m, env);
    }
  }

  /** Nested tx = SAVEPOINT: a constraint violation (guuid replay, SKU race)
   *  aborts only the handler's scope; the outer tx stays healthy for the
   *  idempotency write. */
  private async runHandlerInSavepoint(
    tx: DbTransaction,
    m: SyncMutation,
    handler: SyncMutationHandler,
    effectiveAsOf: Date,
    env: MutationEnv,
  ): Promise<HandlerOutcome> {
    try {
      return await tx.transaction((inner) =>
        handler.apply(m.action, m.payload, m.expected_row_version, {
          tx: inner,
          storeId: env.storeId,
          userId: env.userId,
          deviceId: env.deviceId,
          effectiveAsOf,
        }),
      );
    } catch (error) {
      const mapped = mapConstraintViolation(error);
      if (!mapped) throw error;
      return mapped;
    }
  }

  /** Maps a failure signal out of the (already rolled-back-or-committed)
   *  business tx to its wire result — HandlerRejectedSignal, a lost
   *  idempotency race, or an unexpected handler crash. */
  private async mapExecuteFailure(
    error: unknown,
    m: SyncMutation,
    env: MutationEnv,
  ): Promise<MutationResultWire> {
    if (error instanceof HandlerRejectedSignal) {
      // A CREATE-path DUPLICATE_ENTRY here comes from the entity's own guuid
      // unique-constraint (§11 savepoint), which fires for BOTH a genuine
      // resubmit-of-a-different-mutation-id AND the losing side of a same
      // mutation_id race (two concurrent retries of one dropped ack — neither
      // had committed yet when both passed the pre-tx idempotency check).
      // `idempotency.record()` below is a no-op against the winner's already
      // -committed row in that second case, so recheck for a live winner row
      // before answering `rejected` — the wire contract treats `rejected` as
      // terminal/droppable (unlike `duplicate`), and telling the loser its
      // create failed when the mutation actually already applied lets a
      // client drop the queued item and recreate it with a fresh guuid,
      // producing a real duplicate record.
      if (error.outcome.code === ErrorCodes.DUPLICATE_ENTRY) {
        const winner = await this.idempotency.find(m.mutation_id, env.userId, env.storeId);
        if (winner && this.idempotency.isLive(winner, env.now)) {
          const cached = winner.result as Record<string, unknown>;
          const sanitized = winner.status === 'conflict' ? { ...cached, server_row: undefined } : cached;
          return { mutation_id: m.mutation_id, status: 'duplicate', cached: sanitized };
        }
      }

      const wire: MutationResultWire = {
        mutation_id: m.mutation_id,
        status: 'rejected',
        code: error.outcome.code,
        message: error.outcome.message,
        conflict_type: error.outcome.conflictType,
      };
      await this.idempotency.record({
        mutationId: m.mutation_id,
        userFk: env.userId,
        storeFk: env.storeId,
        entityType: m.entity_type,
        action: m.action,
        status: 'rejected',
        result: wire,
      });
      return wire;
    }

    if (error instanceof RaceLostSignal) {
      return this.pollRaceWinner(m, env);
    }

    // Unknown handler crash — bump the poison counter (outside the rolled-back
    // tx) and return an UNCACHED rejection so an honest retry can succeed.
    const message = error instanceof Error ? error.message : String(error);
    this.logger.error(`mutation ${m.mutation_id} (${m.entity_type}/${m.action}) failed: ${message}`);
    const count = await this.failures.bump(m.mutation_id, env.userId, env.storeId, message);
    if (count >= POISON_MUTATION_MAX_FAILURES) {
      return this.terminalReject(m, env, ErrorCodes.SERVER_ERROR,
        `mutation permanently failed after ${count} attempts`, 'BUSINESS_RULE');
    }
    return {
      mutation_id: m.mutation_id,
      status: 'rejected',
      code: ErrorCodes.SERVER_ERROR,
      message: 'internal error applying mutation — safe to retry',
    };
  }

  /** §10 race: the loser polls for the winner's committed row; exhaustion → 503
   *  aborts the WHOLE call (the client retries the batch and hits `duplicate`). */
  private async pollRaceWinner(m: SyncMutation, env: MutationEnv): Promise<MutationResultWire> {
    const deadline = Date.now() + IDEMPOTENCY_RACE_POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(IDEMPOTENCY_RACE_POLL_INTERVAL_MS);
      const row = await this.idempotency.find(m.mutation_id, env.userId, env.storeId);
      if (row) {
        const cached = row.result as Record<string, unknown>;
        const sanitized = row.status === 'conflict' ? { ...cached, server_row: undefined } : cached;
        return { mutation_id: m.mutation_id, status: 'duplicate', cached: sanitized };
      }
    }
    throw new ServiceUnavailableError(
      ErrorCodes.SERVICE_UNAVAILABLE,
      'concurrent duplicate mutation still in flight — retry the batch',
    );
  }

  // ─── Result plumbing ─────────────────────────────────────────────────────────

  private toWire(m: SyncMutation, outcome: Exclude<HandlerOutcome, { kind: 'rejected' }>): MutationResultWire {
    if (outcome.kind === 'applied') {
      return {
        mutation_id: m.mutation_id,
        status: 'applied',
        entity_id: outcome.entityId,
        entity_guuid: outcome.entityGuuid,
        row_version: outcome.rowVersion,
        data: outcome.data,
      };
    }
    return {
      mutation_id: m.mutation_id,
      status: 'conflict',
      conflict_type: 'MASTER_DATA',
      server_row: outcome.serverRow,
      message: outcome.message,
    };
  }

  /** Deterministic rejection — cached so a blind retry replays as `duplicate`. */
  private async terminalReject(
    m: SyncMutation,
    env: MutationEnv,
    code: ErrorCode,
    message: string,
    conflictType: ConflictType,
  ): Promise<MutationResultWire> {
    const wire: MutationResultWire = {
      mutation_id: m.mutation_id,
      status: 'rejected',
      code,
      message,
      conflict_type: conflictType,
    };
    await this.idempotency.record({
      mutationId: m.mutation_id,
      userFk: env.userId,
      storeFk: env.storeId,
      entityType: m.entity_type,
      action: m.action,
      status: 'rejected',
      result: wire,
    });
    return wire;
  }

  /**
   * Transient block — NOT cached (the state can heal) and signalled as
   * `retry_later`, NOT `rejected`, so the client keeps the mutation queued and
   * re-pushes once the subscription renews / unpauses / reconciles. Emitting
   * `rejected` here would make the client roll the write back and drop a sale
   * rung during a lapse-then-renew (F2).
   */
  private retryLater(m: SyncMutation, code: ErrorCode, message: string): MutationResultWire {
    return {
      mutation_id: m.mutation_id,
      status: 'retry_later',
      code,
      message,
      conflict_type: 'BUSINESS_RULE',
    };
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────

/**
 * Mutation_ids that sit on a `parent_guuid` cycle (C3). The parent graph is
 * functional (each mutation has at most one parent), so a cycle is found by
 * walking the parent chain and detecting a revisit of a node already on the
 * current path — every node from the revisit point onward is on the cycle
 * (self-parent = a cycle of one). These are rejected up front with
 * PARENT_CYCLE instead of topoSort silently breaking the loop and applying a
 * child before its parent.
 */
export function findParentCycleMutationIds(mutations: SyncMutation[]): Set<string> {
  const byGuuid = new Map<string, SyncMutation>();
  for (const m of mutations) {
    const guuid = typeof m.payload.guuid === 'string' ? m.payload.guuid : undefined;
    if (guuid && !byGuuid.has(guuid)) byGuuid.set(guuid, m);
  }

  const settled = new Set<string>();
  const inCycle = new Set<string>();

  for (const start of mutations) {
    if (settled.has(start.mutation_id)) continue;
    const path: SyncMutation[] = [];
    const onPath = new Set<string>();
    let cur: SyncMutation | undefined = start;
    while (cur && !settled.has(cur.mutation_id)) {
      if (onPath.has(cur.mutation_id)) {
        // Revisit → cycle. Capture from the revisited node to the path tail.
        let capture = false;
        for (const node of path) {
          if (node.mutation_id === cur.mutation_id) capture = true;
          if (capture) inCycle.add(node.mutation_id);
        }
        break;
      }
      path.push(cur);
      onPath.add(cur.mutation_id);
      cur = cur.parent_guuid ? byGuuid.get(cur.parent_guuid) : undefined;
    }
    for (const node of path) settled.add(node.mutation_id);
  }
  return inCycle;
}

/**
 * Stable dependency sort by parent_guuid (S-3a): parents before children
 * whatever order the client sent. Assumes cycle members have already been
 * removed (findParentCycleMutationIds / C3); the stack guard below is a
 * belt-and-suspenders against re-entry, not the cycle policy.
 */
export function topoSort(mutations: SyncMutation[]): SyncMutation[] {
  const byGuuid = new Map<string, SyncMutation>();
  for (const m of mutations) {
    const guuid = typeof m.payload.guuid === 'string' ? m.payload.guuid : undefined;
    if (guuid && !byGuuid.has(guuid)) byGuuid.set(guuid, m);
  }

  const emitted = new Set<string>();
  const out: SyncMutation[] = [];

  const visit = (m: SyncMutation, stack: Set<string>): void => {
    if (emitted.has(m.mutation_id) || stack.has(m.mutation_id)) return;
    stack.add(m.mutation_id);
    const parent = m.parent_guuid ? byGuuid.get(m.parent_guuid) : undefined;
    if (parent) visit(parent, stack);
    stack.delete(m.mutation_id);
    emitted.add(m.mutation_id);
    out.push(m);
  };

  for (const m of mutations) visit(m, new Set());
  return out;
}

/**
 * Group an already-topo-sorted, deduped mutation list into concurrency
 * "waves": a mutation's wave is one greater than its parent's wave (if any)
 * AND one greater than the wave of the last mutation seen touching the same
 * entity guuid (if any) — otherwise wave 0. Mutations in the same wave share
 * no dependency and no target entity, so they can safely run via
 * `Promise.all` without disturbing S-3a/S-3b cascade ordering or the
 * within-batch ordering of repeated edits to one entity.
 */
export function computeWaves(mutations: SyncMutation[]): SyncMutation[][] {
  const byGuuid = new Map<string, SyncMutation>();
  for (const m of mutations) {
    const guuid = typeof m.payload.guuid === 'string' ? m.payload.guuid : undefined;
    if (guuid && !byGuuid.has(guuid)) byGuuid.set(guuid, m);
  }

  const waveOf = new Map<string, number>();
  const lastWaveForGuuid = new Map<string, number>();

  for (const m of mutations) {
    let wave = 0;
    if (m.parent_guuid) {
      const parent = byGuuid.get(m.parent_guuid);
      if (parent && parent.mutation_id !== m.mutation_id) {
        wave = Math.max(wave, (waveOf.get(parent.mutation_id) ?? 0) + 1);
      }
    }
    const guuid = typeof m.payload.guuid === 'string' ? m.payload.guuid : undefined;
    if (guuid && lastWaveForGuuid.has(guuid)) {
      wave = Math.max(wave, lastWaveForGuuid.get(guuid)! + 1);
    }
    waveOf.set(m.mutation_id, wave);
    if (guuid) lastWaveForGuuid.set(guuid, wave);
  }

  const waves: SyncMutation[][] = [];
  for (const m of mutations) {
    const wave = waveOf.get(m.mutation_id)!;
    (waves[wave] ??= []).push(m);
  }
  return waves;
}

/** Postgres constraint violations from the handler savepoint → per-mutation rejections. */
function mapConstraintViolation(error: unknown): HandlerOutcome | null {
  const code = unwrapPgError(error)?.code;
  if (code === '23505') {
    return {
      kind: 'rejected',
      code: ErrorCodes.DUPLICATE_ENTRY,
      message: 'This was already saved from another device.',
      conflictType: 'VALIDATION',
    };
  }
  if (code === '23503') {
    return {
      kind: 'rejected',
      code: ErrorCodes.FOREIGN_KEY_VIOLATION,
      message: 'This record no longer exists — it may have been deleted elsewhere.',
      conflictType: 'VALIDATION',
    };
  }
  return null;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
