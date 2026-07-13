import * as Crypto from 'expo-crypto';
import { ulid } from './ulid';
import { getSyncDb } from '../db/client';
import { withTransaction } from '../db/transaction';
import { customerRepository } from '../repositories/customer.repository';
import { mutationQueueRepository } from '../repositories/mutation-queue.repository';
import { requestImmediateSync } from '../scheduler-instance';

export interface CreateCustomerInput {
  name: string;
  phone?: string;
  email?: string;
  website?: string;
  panNumber?: string;
  gstNumber?: string;
  creditLimit?: string; // canonical "12.34"-style string (payload-helpers.ts `money`)
  overrideCreditLimit?: boolean;
  paymentTermDays?: number;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  district?: string;
  /** The selected STATE lookup's guuid — the server resolves it to
   *  `state_lookup_fk` (globalOrStore scope, customer.handler.ts). */
  stateLookupGuuid?: string;
  pinCode?: string;
  birthday?: string; // ISO YYYY-MM-DD
  anniversary?: string;
  notes?: string;
}

/**
 * Optimistic create (mobile-11 §6.1): write the local row + enqueue the
 * mutation in ONE transaction — a crash between the two must not leave a
 * queued mutation with no local row to show for it, or vice versa. The temp
 * local `id` is the client-generated `guuid`; once `applied` returns,
 * drain-queue.ts swaps in the authoritative row under the server's real id.
 *
 * `customerTypeLookupFk` is intentionally not settable here — it needs a lookup
 * picker (not yet built); the column stays null and can be added later without
 * touching this contract.
 */
export async function enqueueCreateCustomer(
  storeId: string,
  input: CreateCustomerInput,
  guuid: string = Crypto.randomUUID(),
): Promise<string> {
  const mutationId = ulid();
  const now = new Date().toISOString();

  const db = getSyncDb();
  await withTransaction(db, async (tx) => {
    await customerRepository.upsertAll(tx, storeId, [
      {
        id: guuid,
        guuid,
        name: input.name,
        phone: input.phone ?? null,
        email: input.email ?? null,
        website: input.website ?? null,
        pan_number: input.panNumber ?? null,
        gst_number: input.gstNumber ?? null,
        customer_type_lookup_fk: null,
        credit_limit: input.creditLimit ?? null,
        override_credit_limit: input.overrideCreditLimit ?? null,
        payment_term_days: input.paymentTermDays ?? null,
        address_line_1: input.addressLine1 ?? null,
        address_line_2: input.addressLine2 ?? null,
        city: input.city ?? null,
        district: input.district ?? null,
        // Optimistically null (we hold the guuid, not the local lookup id); the
        // authoritative row from the next pull fills the resolved FK — same
        // deferral as customer_type_lookup_fk above.
        state_lookup_fk: null,
        pin_code: input.pinCode ?? null,
        birthday: input.birthday ?? null,
        anniversary: input.anniversary ?? null,
        notes: input.notes ?? null,
        is_active: true,
        row_version: 0, // placeholder — overwritten once the server confirms
        modified_at: now,
      },
    ]);

    await mutationQueueRepository.enqueue(tx, {
      mutationId,
      storeId,
      entityType: 'customer',
      entityGuuid: guuid,
      action: 'create',
      payload: {
        guuid,
        name: input.name,
        phone: input.phone,
        email: input.email,
        website: input.website,
        pan_number: input.panNumber,
        gst_number: input.gstNumber,
        credit_limit: input.creditLimit,
        override_credit_limit: input.overrideCreditLimit,
        payment_term_days: input.paymentTermDays,
        address_line_1: input.addressLine1,
        address_line_2: input.addressLine2,
        city: input.city,
        district: input.district,
        state_lookup_guuid: input.stateLookupGuuid,
        pin_code: input.pinCode,
        birthday: input.birthday,
        anniversary: input.anniversary,
        notes: input.notes,
      },
      clientModifiedAt: now,
      now,
    });
  });

  requestImmediateSync();
  return guuid;
}
