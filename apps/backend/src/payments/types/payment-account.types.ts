/**
 * Domain shapes for payment accounts (camelCase, internal). These are the types
 * the service and repository speak; the request mapper translates the snake_case
 * wire DTO into the `*Input` shapes, and the response mapper translates
 * `PaymentAccountRow` back out. Kept here (not in `dto/`) so no lower layer has
 * to import a wire DTO to name a domain value.
 */

/** Human-readable reference metadata — display/reconciliation only, never used
 *  in checkout routing. */
export interface PaymentAccountDetails {
  reference?: string;
}

/** A payment-account row as read by the repository. guuid is the public
 *  identifier; the internal row id is never exposed. */
export interface PaymentAccountRow {
  guuid: string;
  name: string;
  kind: string;
  details: PaymentAccountDetails | null;
  isDefault: boolean;
  isActive: boolean;
  isSystem: boolean;
  systemKey: string | null;
  rowVersion: number;
}

/** The acting principal for a management write. */
export interface Actor {
  userId: string;
  deviceId: string;
}

/** Create input (camelCase domain shape produced by the request mapper). */
export interface CreatePaymentAccountInput {
  name: string;
  kind?: string;
  details?: PaymentAccountDetails | null;
  isDefault?: boolean;
}

/** Update input — `expectedRowVersion` drives the optimistic lock; every other
 *  field is a sparse patch (undefined = leave unchanged). */
export interface UpdatePaymentAccountInput {
  name?: string;
  kind?: string;
  details?: PaymentAccountDetails | null;
  isDefault?: boolean;
  isActive?: boolean;
  expectedRowVersion: number;
}