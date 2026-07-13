import { Module } from '@nestjs/common';
import { AccountPostingService } from './account-posting.service.js';

/**
 * Money-event posting logic (docs/prd/accounts-and-ledger.md). Exported for
 * SyncModule to inject into the append-only event handlers — kept as its own
 * module (rather than living inside sync/) because it's domain logic, not
 * sync plumbing, and will grow to cover sale/refund/vendor-payment postings.
 */
@Module({
  providers: [AccountPostingService],
  exports: [AccountPostingService],
})
export class LedgerModule {}