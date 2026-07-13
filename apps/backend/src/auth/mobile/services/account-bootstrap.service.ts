import { Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { type DbTransaction } from '#db/db.module.js';
import { unwrapPgError } from '#db/rethrow-unique-violation.js';
import { AppException } from '#common/exceptions/app.exception.js';
import { ErrorCodes } from '#common/error-codes.js';
import { AccountBootstrapRepository } from '../repositories/account-bootstrap.repository.js';

/** account_number collisions are astronomically rare (6 chars from a
 *  32-symbol alphabet) but not impossible — a couple of regenerate-and-retry
 *  attempts are far cheaper than letting a raw 23505 abort the whole signup. */
const ACCOUNT_NUMBER_MAX_ATTEMPTS = 3;

/** Every new signup starts on this plan; the trial window opens at first store-create. */
const TRIAL_PLAN_NAME = 'free';

export interface BootstrappedAccount {
  accountId: string;
  accountNumber: string;
  subscriptionId: string;
}

/**
 * Provisions the tenant layer for a brand-new user, inside the caller's
 * transaction (so it commits/rolls back with user creation):
 *
 *   1. accounts               { owner_user_fk = user }   ← user owns the account
 *   2. account_users          { account, user }          ← membership
 *   3. account_subscriptions  { account, plan=free, trialing, 14-day trial }
 *
 * Account ownership is accounts.owner_user_fk — NOT an RBAC role (rbac.md §26.4).
 * Stores + STORE_OWNER are created later by the store-creation flow.
 */
@Injectable()
export class AccountBootstrapService {
  constructor(private readonly repo: AccountBootstrapRepository) {}

  async bootstrap(
    userId: string,
    tx: DbTransaction,
  ): Promise<BootstrappedAccount> {
    // Resolve the trial plan — must be seeded (db:seed). Fail loudly if missing.
    const planId = await this.repo.findPlanIdByName(TRIAL_PLAN_NAME, tx);
    if (!planId) {
      throw new AppException(
        ErrorCodes.INTERNAL_ERROR,
        'TRIAL_PLAN_NOT_CONFIGURED',
        500,
      );
    }

    const account = await this.insertAccountWithRetry(userId, tx);

    await this.repo.insertMembership({ accountFk: account.id, userFk: userId }, tx);

    // The trial clock does NOT start at signup — it starts when the user creates
    // their first store (subscription.md §1). The store-create flow stamps
    // trial_ends_at / access_valid_until and flips has_used_trial.
    const subscription = await this.repo.insertTrialingSubscription(
      { accountFk: account.id, planFk: planId },
      tx,
    );

    return {
      accountId: account.id,
      accountNumber: account.accountNumber,
      subscriptionId: subscription.id,
    };
  }

  /**
   * Insert the account, regenerating account_number and retrying on a
   * collision (up to ACCOUNT_NUMBER_MAX_ATTEMPTS times). Each attempt runs in
   * its own SAVEPOINT (nested tx) — a plain retry-in-place would fail because
   * a Postgres transaction is aborted for all subsequent commands once any
   * statement in it errors; the nested tx confines that abort to just this
   * attempt, same pattern as delta.service.ts's runHandlerInSavepoint.
   */
  private async insertAccountWithRetry(
    userId: string,
    tx: DbTransaction,
  ): Promise<{ id: string; accountNumber: string }> {
    for (let attempt = 1; attempt <= ACCOUNT_NUMBER_MAX_ATTEMPTS; attempt++) {
      try {
        return await tx.transaction((inner) =>
          this.repo.insertAccount(
            {
              accountNumber: this.generateAccountNumber(),
              name: 'My Business', // internal label; user renames later
              ownerUserFk: userId,
            },
            inner,
          ),
        );
      } catch (err) {
        const pgErr = unwrapPgError(err);
        const isCollision =
          pgErr?.code === '23505' && pgErr.constraint_name === 'accounts_account_number_unique';
        if (!isCollision || attempt === ACCOUNT_NUMBER_MAX_ATTEMPTS) throw err;
      }
    }
    // Unreachable — the loop always either returns or throws.
    throw new AppException(ErrorCodes.INTERNAL_ERROR, 'ACCOUNT_NUMBER_GENERATION_FAILED', 500);
  }

  /** 'ACC-XXXXXX' — 6 uppercase alphanumerics. account_number is UNIQUE. */
  private generateAccountNumber(): string {
    const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no ambiguous 0/O/1/I/L
    const bytes = randomBytes(6);
    let suffix = '';
    for (let i = 0; i < 6; i++) suffix += alphabet[bytes[i]! % alphabet.length];
    return `ACC-${suffix}`;
  }
}
