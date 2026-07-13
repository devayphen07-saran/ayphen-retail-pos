import type { LocalAccountTransaction } from '@core/sync/repositories/account-transaction.repository';
import type { LocalCashMovement } from '@core/sync/repositories/cash-movement.repository';

export type LedgerDirection = 'credit' | 'debit';

export interface LedgerRow {
  id: string;
  direction: LedgerDirection;
  amountPaise: number;
  reason: string;
  note: string | null;
  modifiedAt: string;
  /** True until the server-derived `account_transactions` posting for this
   *  movement has synced back down — see docs/prd/accounts-and-ledger.md D1:
   *  the event is written locally right away, but it isn't "truth" (and isn't
   *  in the balance total) until the server round-trips its posting. */
  pending: boolean;
}

/** `cash_movements.type` → ledger direction — mirrors
 *  apps/backend/src/ledger/account-posting.service.ts's CASH_MOVEMENT_DIRECTION
 *  (kept in sync manually; there is no shared package between the two runtimes). */
const CASH_MOVEMENT_DIRECTION: Record<string, LedgerDirection> = {
  payin: 'credit',
  tip: 'credit',
  payout: 'debit',
  drop: 'debit',
};

/**
 * Merges the server-confirmed ledger (`account_transactions`) with locally
 * queued-but-unconfirmed manual movements (`cash_movements`) into one display
 * list, newest first. A movement stops appearing as "pending" the moment its
 * posted counterpart (`account_transactions.source_fk === movement.id`)
 * shows up from a pull — this is a pure read-side merge; nothing here is
 * persisted.
 */
export function mergeLedgerRows(
  confirmed: LocalAccountTransaction[],
  localMovements: LocalCashMovement[],
): LedgerRow[] {
  const postedSourceIds = new Set(
    confirmed.filter((t) => t.sourceType === 'cash_movement' && t.sourceFk).map((t) => t.sourceFk as string),
  );

  const confirmedRows: LedgerRow[] = confirmed.map((t) => ({
    id: t.id,
    direction: (t.direction as LedgerDirection) ?? 'credit',
    amountPaise: t.amountPaise,
    reason: t.reason ?? '',
    note: t.note,
    modifiedAt: t.modifiedAt,
    pending: false,
  }));

  const pendingRows: LedgerRow[] = localMovements
    .filter((m) => !postedSourceIds.has(m.id))
    .map((m) => ({
      id: m.id,
      direction: CASH_MOVEMENT_DIRECTION[m.type ?? ''] ?? 'credit',
      amountPaise: m.amountPaise,
      reason: m.reason ?? m.type ?? '',
      note: null,
      modifiedAt: m.modifiedAt,
      pending: true,
    }));

  return [...confirmedRows, ...pendingRows].sort((a, b) =>
    b.modifiedAt.localeCompare(a.modifiedAt),
  );
}

/** Balance = Σ over the server-confirmed projection ONLY (D-SD2) — pending
 *  rows are excluded so a not-yet-posted movement never double-counts once
 *  its posting lands. */
export function computeBalancePaise(confirmed: LocalAccountTransaction[]): number {
  return confirmed.reduce(
    (sum, t) => sum + (t.direction === 'debit' ? -t.amountPaise : t.amountPaise),
    0,
  );
}