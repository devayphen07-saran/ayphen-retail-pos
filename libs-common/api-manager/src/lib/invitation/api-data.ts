import { APIData, APIMethod } from '../api-handler';

/** Create a staff invitation for a store — owner/manager side. Requires the
 *  Invitation.create permission. Pass `{ pathParam: { storeId }, bodyParam }`. */
export const CREATE_INVITATION = new APIData('stores/:storeId/invitations', APIMethod.POST);

/** List the authenticated user's own pending invitations. Auth required. */
export const LIST_MY_INVITATIONS = new APIData('me/invitations', APIMethod.GET);

/** Accept an invitation by raw token — for out-of-band delivery (SMS/email
 *  deep link). The token carries the store. Auth required. */
export const ACCEPT_INVITATION = new APIData('invitations/accept', APIMethod.POST);

/** Decline an invitation by raw token (deep link). Auth required. */
export const REJECT_INVITATION = new APIData('invitations/reject', APIMethod.POST);

/** Accept an in-app invitation by id (from LIST_MY_INVITATIONS). No token is
 *  echoed — the server authorizes by the caller's own contact. Pass
 *  `{ pathParam: { invitationId } }`. Auth required. */
export const ACCEPT_INVITATION_BY_ID = new APIData('invitations/:invitationId/accept', APIMethod.POST);

/** Decline an in-app invitation by id. Pass `{ pathParam: { invitationId } }`. Auth required. */
export const REJECT_INVITATION_BY_ID = new APIData('invitations/:invitationId/reject', APIMethod.POST);
