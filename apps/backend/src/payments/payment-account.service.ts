import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnprocessableError,
} from '#common/exceptions/app.exception.js';
import { ErrorCodes } from '#common/error-codes.js';
import { UnitOfWork } from '#db/db.module.js';
import { unwrapPgError } from '#db/rethrow-unique-violation.js';
import { PaymentAccountMutationHandler } from '../sync/push/handlers/payment-account.handler.js';
import type { HandlerOutcome, MutationAction } from '../sync/push/mutation.types.js';
import { PaymentAccountRepository } from './payment-account.repository.js';
import type {
  Actor,
  CreatePaymentAccountInput,
  PaymentAccountRow,
  UpdatePaymentAccountInput,
} from './types/payment-account.types.js';

export type { Actor };

/**
 * Management REST surface for payment accounts (PRD payment-accounts-mobile §0).
 * Writes reuse the sync `PaymentAccountMutationHandler` verbatim — the SAME
 * seed-lock, single-default, name-trim, fk-resolve and tombstone-on-delete rules
 * the offline sync path enforces — so the two entry points can never diverge
 * (DR-6). The row_version/modified_at trigger fires on every write, so a REST
 * change is picked up by the next sync pull → checkout's local cache stays fresh.
 */
@Injectable()
export class PaymentAccountService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly repo: PaymentAccountRepository,
    private readonly handler: PaymentAccountMutationHandler,
  ) {}

  list(storeId: string): Promise<PaymentAccountRow[]> {
    return this.repo.listAlive(storeId);
  }

  async create(
    storeId: string,
    actor: Actor,
    input: CreatePaymentAccountInput,
  ): Promise<PaymentAccountRow> {
    const guuid = randomUUID();
    // camelCase domain input → the sync handler's snake_case wire payload; this
    // is the one place the service touches the handler's wire contract.
    const outcome = await this.run(storeId, actor, 'create', {
      guuid,
      name: input.name,
      kind: input.kind,
      details: input.details,
      is_default: input.isDefault,
    });
    this.assertApplied(outcome);
    return this.requireRow(storeId, guuid);
  }

  async update(
    storeId: string,
    actor: Actor,
    guuid: string,
    input: UpdatePaymentAccountInput,
  ): Promise<PaymentAccountRow> {
    const payload: Record<string, unknown> = { guuid };
    if (input.name !== undefined) payload.name = input.name;
    if (input.kind !== undefined) payload.kind = input.kind;
    if (input.details !== undefined) payload.details = input.details;
    if (input.isDefault !== undefined) payload.is_default = input.isDefault;
    if (input.isActive !== undefined) payload.is_active = input.isActive;

    const outcome = await this.run(storeId, actor, 'update', payload, input.expectedRowVersion);
    this.assertApplied(outcome);
    return this.requireRow(storeId, guuid);
  }

  async remove(storeId: string, actor: Actor, guuid: string): Promise<void> {
    const outcome = await this.run(storeId, actor, 'delete', { guuid });
    this.assertApplied(outcome);
  }

  private async run(
    storeId: string,
    actor: Actor,
    action: MutationAction,
    payload: Record<string, unknown>,
    expectedRowVersion?: number,
  ): Promise<HandlerOutcome> {
    try {
      return await this.uow.execute((tx) =>
        this.handler.apply(action, payload, expectedRowVersion, {
          tx,
          storeId,
          userId: actor.userId,
          deviceId: actor.deviceId,
          // Online write — "when it was queued" is now.
          effectiveAsOf: new Date(),
        }),
      );
    } catch (err) {
      // Constraint violations bubble raw from the handler when it's called
      // outside the sync savepoint pipeline — map them to clean HTTP errors.
      const code = unwrapPgError(err)?.code;
      if (code === '23505') {
        throw new ConflictError(
          ErrorCodes.DUPLICATE_ENTRY,
          'An account with this name already exists.',
        );
      }
      if (code === '23514') {
        // ck_payment_accounts_default_active (#5): an inactive account can't be
        // the default — deactivating the default is rejected (reassign first).
        throw new UnprocessableError(
          ErrorCodes.VALIDATION_FAILED,
          'An inactive account cannot be the default. Set another account as default first.',
        );
      }
      throw err;
    }
  }

  /** Translate a non-applied handler outcome into the right HTTP error. */
  private assertApplied(outcome: HandlerOutcome): void {
    if (outcome.kind === 'applied') return;
    if (outcome.kind === 'conflict') {
      throw new ConflictError(ErrorCodes.CONFLICT, outcome.message, {
        serverRow: outcome.serverRow,
      });
    }
    switch (outcome.code) {
      case ErrorCodes.PAYMENT_ACCOUNT_PROTECTED:
        throw new ForbiddenError(outcome.code, outcome.message);
      case ErrorCodes.DUPLICATE_ENTRY:
        throw new ConflictError(outcome.code, outcome.message);
      case ErrorCodes.NOT_FOUND:
        throw new NotFoundError(outcome.code, outcome.message);
      default:
        throw new UnprocessableError(outcome.code, outcome.message);
    }
  }

  private async requireRow(storeId: string, guuid: string): Promise<PaymentAccountRow> {
    const row = await this.repo.findOne(storeId, guuid);
    if (!row) throw new NotFoundError(ErrorCodes.NOT_FOUND, 'Payment account not found');
    return row;
  }
}
