import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LIST_MY_INVITATIONS, ACCEPT_INVITATION, REJECT_INVITATION } from './api-data';
import type {
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
