import { Alert } from '@ayphen/mobile-ui-components';

/**
 * Appends an offline-aware note to a success message. A mutation enqueued
 * while offline is only queued locally — it hasn't reached the server yet —
 * so the checkout-style screens (Pos/Refund/CollectPayment/PaySupplierBill/
 * CreateSupplierBill) must not word it as already confirmed server-side.
 */
export function withSyncNote(message: string, isOffline: boolean): string {
  return isOffline ? `${message} It'll sync once you're back online.` : message;
}

/** Shown when a mutation's local enqueue throws — e.g. a local SQLite write
 *  failure — so the user isn't left believing an unsaved sale/refund/payment
 *  went through. */
export function showMutationError(): void {
  Alert.show("Couldn't save", 'Something went wrong and this was not recorded. Please try again.');
}