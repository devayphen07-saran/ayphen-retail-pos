import { APIData, APIMethod } from '../api-handler';

/** List the authenticated user's own pending invitations. Auth required. */
export const LIST_MY_INVITATIONS = new APIData('me/invitations', APIMethod.GET);

/** Accept an invitation by token — the token carries the store. Auth required. */
export const ACCEPT_INVITATION = new APIData('invitations/accept', APIMethod.POST);

/** Decline an invitation by token. Auth required. */
export const REJECT_INVITATION = new APIData('invitations/reject', APIMethod.POST);
