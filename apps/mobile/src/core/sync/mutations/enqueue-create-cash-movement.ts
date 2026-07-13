import * as Crypto from 'expo-crypto';
import { ulid } from './ulid';
import { getSyncDb } from '../db/client';
import { withTransaction } from '../db/transaction';
import { cashMovementRepository } from '../repositories/cash-movement.repository';
import { mutationQueueRepository } from '../repositories/mutation-queue.repository';
import { requestImmediateSync } from '../scheduler-instance';

/** Money mutations drain before master-data edits (docs/prd/accounts-and-ledger.md
 *  Phase 0 "queue priority: HIGH") — revenue/cash movements never starve
 *  behind a product rename sitting earlier in the queue. */
const CASH_MOVEMENT_MUTATION_PRIORITY = 10;

export interface CreateCashMovementInput {
  /** The account this movement posts against — its resolved LOCAL id (not
   *  guuid): unlike a supplier's lookup FK, the target account is always
   *  already in hand here (the user navigated from its own detail screen), so
   *  there is no null-placeholder-then-resolve step. */
  accountId: string;
  accountGuuid: string;
  type: 'payin' | 'payout';
  amountPaise: number;
  reason?: string;
}

/**
 * Manual cash in/out (F4). One local transaction: write the event row +
 * enqueue, same crash-safety contract as enqueueCreateSupplier. The
 * `account_transactions` posting this derives is NOT written here — it is
 * server-only (BR-3); the Account Detail screen shows this row as "pending"
 * until the posted projection row arrives on the next pull.
 */
export async function enqueueCreateCashMovement(
  storeId: string,
  input: CreateCashMovementInput,
  guuid: string = Crypto.randomUUID(),
): Promise<string> {
  const mutationId = ulid();
  const now = new Date().toISOString();

  const db = getSyncDb();
  await withTransaction(db, async (tx) => {
    await cashMovementRepository.upsertAll(tx, storeId, [
      {
        id: guuid,
        guuid,
        account_fk: input.accountId,
        type: input.type,
        reason: input.reason ?? null,
        amount_paise: input.amountPaise,
        by_user_fk: null, // server-stamped (ctx.userId) — unknown client-side
        row_version: 0, // vestigial for this append-only entity; never compared
        modified_at: now,
      },
    ]);

    await mutationQueueRepository.enqueue(tx, {
      mutationId,
      storeId,
      entityType: 'cash_movement',
      entityGuuid: guuid,
      action: 'create',
      priority: CASH_MOVEMENT_MUTATION_PRIORITY,
      payload: {
        guuid,
        account_guuid: input.accountGuuid,
        type: input.type,
        reason: input.reason,
        amount_paise: input.amountPaise,
      },
      clientModifiedAt: now,
      now,
    });
  });

  requestImmediateSync();
  return guuid;
}