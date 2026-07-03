import { Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { eq } from 'drizzle-orm';
import { type DbTransaction } from '#db/db.module.js';
import {
  accounts,
  accountUsers,
  accountSubscriptions,
  plans,
} from '#db/schema.js';
import { AppException } from '#common/exceptions/app.exception.js';
import { ErrorCodes } from '#common/error-codes.js';

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
  async bootstrap(
    userId: string,
    tx: DbTransaction,
  ): Promise<BootstrappedAccount> {
    // Resolve the trial plan — must be seeded (db:seed). Fail loudly if missing.
    const [plan] = await tx
      .select({ id: plans.id })
      .from(plans)
      .where(eq(plans.name, TRIAL_PLAN_NAME));
    if (!plan) {
      throw new AppException(
        ErrorCodes.INTERNAL_ERROR,
        'TRIAL_PLAN_NOT_CONFIGURED',
        500,
      );
    }

    const [account] = await tx
      .insert(accounts)
      .values({
        accountNumber: this.generateAccountNumber(),
        name: 'My Business', // internal label; user renames later
        ownerUserFk: userId,
      })
      .returning({ id: accounts.id, accountNumber: accounts.accountNumber });

    await tx.insert(accountUsers).values({
      accountFk: account!.id,
      userFk: userId,
    });

    // The trial clock does NOT start at signup — it starts when the user creates
    // their first store (subscription.md §1). Here we create the subscription in
    // 'trialing' with no window yet; the store-create flow stamps trial_ends_at /
    // access_valid_until and flips has_used_trial. The DB CHECK allows a null
    // access_valid_until only while status = 'trialing'.
    const [subscription] = await tx
      .insert(accountSubscriptions)
      .values({
        accountFk: account!.id,
        planFk: plan.id,
        status: 'trialing',
        trialEndsAt: null,
        accessValidUntil: null,
        hasUsedTrial: false,
      })
      .returning({ id: accountSubscriptions.id });

    return {
      accountId: account!.id,
      accountNumber: account!.accountNumber,
      subscriptionId: subscription!.id,
    };
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
