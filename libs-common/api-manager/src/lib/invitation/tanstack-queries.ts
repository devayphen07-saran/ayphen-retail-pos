import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CREATE_INVITATION,
  LIST_MY_INVITATIONS,
  ACCEPT_INVITATION,
  REJECT_INVITATION,
  ACCEPT_INVITATION_BY_ID,
  REJECT_INVITATION_BY_ID,
} from './api-data';
import type {
  CreateInvitationRequest,
  CreateInvitationResponse,
  MyInvitationResponse,
  AcceptInvitationRequest,
  AcceptInvitationResponse,
  RejectInvitationRequest,
  RejectInvitationResponse,
} from './types';

export const invitationKeys = {
  all: ['invitations'] as const,
  mine: () => [...invitationKeys.all, 'mine'] as const,
};

/** Create a staff invitation (owner/manager side). Caller passes
 *  `{ pathParam: { storeId }, bodyParam: CreateInvitationRequest }`. */
export const useCreateInvitationMutation = () =>
  useMutation(
    CREATE_INVITATION.mutationOptions<CreateInvitationResponse, CreateInvitationRequest>(),
  );

/** The current user's own pending invitations (mobile-03 §8D.3/8D.4). */
export const useMyInvitationsQuery = (options?: { enabled?: boolean }) =>
  useQuery({
    ...LIST_MY_INVITATIONS.queryOptions<MyInvitationResponse[]>(),
    queryKey: invitationKeys.mine(),
    enabled: options?.enabled ?? true,
  });

/** Accept an invitation, then drop the cached pending list (it's stale now). */
export const useAcceptInvitationMutation = () => {
  const queryClient = useQueryClient();
  return useMutation(
    ACCEPT_INVITATION.mutationOptions<AcceptInvitationResponse, AcceptInvitationRequest>({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: invitationKeys.mine() });
      },
    }),
  );
};

/** Decline an invitation, then drop the cached pending list (it's stale now). */
export const useRejectInvitationMutation = () => {
  const queryClient = useQueryClient();
  return useMutation(
    REJECT_INVITATION.mutationOptions<RejectInvitationResponse, RejectInvitationRequest>({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: invitationKeys.mine() });
      },
    }),
  );
};

/**
 * Accept an in-app invitation by id (from useMyInvitationsQuery). Call with
 * `{ pathParam: { id } }` — no token echoed. Drops the pending list on success.
 */
export const useAcceptInvitationByIdMutation = () => {
  const queryClient = useQueryClient();
  return useMutation(
    ACCEPT_INVITATION_BY_ID.mutationOptions<AcceptInvitationResponse>({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: invitationKeys.mine() });
      },
    }),
  );
};

/** Decline an in-app invitation by id. Call with `{ pathParam: { id } }`. */
export const useRejectInvitationByIdMutation = () => {
  const queryClient = useQueryClient();
  return useMutation(
    REJECT_INVITATION_BY_ID.mutationOptions<RejectInvitationResponse>({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: invitationKeys.mine() });
      },
    }),
  );
};
