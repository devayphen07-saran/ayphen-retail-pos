import { APIData, APIMethod } from '../api-handler';

/**
 * Subscription + billing (subscription.md §9/§12/§13/§16/§19). Every route
 * lives under `/me` — mirrors `apps/backend/src/subscription/me-subscription.controller.ts`
 * exactly. Account-scoped (member-visible reads, owner-gated mutations); the
 * server resolves the account from the authenticated user, never from a path param.
 */

/** Full subscription read model — the freshness re-fetch target (§16/§19). */
export const GET_SUBSCRIPTION = new APIData('me/subscription', APIMethod.GET);

/** Cheap poll target — just the version counter. */
export const GET_SUBSCRIPTION_VERSION = new APIData('me/subscription/version', APIMethod.GET);

/** Purchasable plan catalog. Static config — cache ~24h client-side (§22B). */
export const GET_SUBSCRIPTION_PLANS = new APIData('me/subscription/plans', APIMethod.GET);

/** Create a payment order for a plan (§9). Owner + step-up required server-side. */
export const CREATE_SUBSCRIPTION_CHECKOUT = new APIData(
  'me/subscription/checkout',
  APIMethod.POST,
);

/** Verify a client-reported payment → activate (§9). Owner + step-up required server-side. */
export const VERIFY_SUBSCRIPTION_PAYMENT = new APIData(
  'me/subscription/verify',
  APIMethod.POST,
);

/** Request cancellation at period end (§12). Owner + step-up required server-side. */
export const CANCEL_SUBSCRIPTION = new APIData('me/subscription/cancel', APIMethod.POST);

/** Undo a pending cancellation, still within the paid period (§13 case A). Owner + step-up required server-side. */
export const REACTIVATE_SUBSCRIPTION = new APIData('me/subscription/reactivate', APIMethod.POST);

/** The downgrade resolve screen's data — every store/device the owner can
 *  choose to keep, plus the plan's new limits. */
export const GET_RECONCILIATION = new APIData('me/subscription/reconciliation', APIMethod.GET);

/** The owner's downgrade resolution. Owner + step-up required server-side. */
export const RESOLVE_RECONCILIATION = new APIData('me/subscription/reconciliation', APIMethod.POST);

/** Post-downgrade flexibility — swap which store is active without redoing
 *  the full resolve flow. Owner + step-up required server-side. */
export const SWAP_ACTIVE_STORE = new APIData('me/subscription/active-store', APIMethod.POST);
