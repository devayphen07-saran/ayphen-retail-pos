import { useCallback, useState } from 'react';
import { router, useFocusEffect } from 'expo-router';
import { Alert, AppLayout, ListScaffold } from '@ayphen/mobile-ui-components';
import {
  useMyInvitationsQuery,
  useAcceptInvitationByIdMutation,
  useRejectInvitationByIdMutation,
  type MyInvitationResponse,
} from '@ayphen/api-manager';
import { setLastOpenedStoreId } from '@features/store/shared/utils/prefs';
import { useAuth } from '@core/providers/AuthProvider';
import { useAuthStore } from '@store';
import { InvitationRowSkeleton } from '../loading/InvitationRowSkeleton';
import { InviteCard } from '../components/InviteCard';

/** Reached from the Onboarding Hub's invite banner/badge — accept or reject
 *  a pending invitation (post-login-onboarding-flow.md §4). */
export function InvitationsScreen() {
  const { refetchUser } = useAuth();
  const { data: invitations, isLoading, isError, isFetching, isRefetching, refetch } =
    useMyInvitationsQuery();
  const acceptInvitation = useAcceptInvitationByIdMutation();
  const rejectInvitation = useRejectInvitationByIdMutation();
  const [acceptingId, setAcceptingId] = useState<string | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const busyId = acceptingId ?? rejectingId;

  // Refetch whenever this screen regains focus (loading-agent.md §12), e.g.
  // returning here after creating/joining a store elsewhere in the stack.
  useFocusEffect(
    useCallback(() => {
      refetch();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
  );

  const onAccept = useCallback(
    async (invite: MyInvitationResponse) => {
      setAcceptingId(invite.id);
      try {
        const res = await acceptInvitation.mutateAsync({ pathParam: { invitationId: invite.id } });
        await setLastOpenedStoreId(res.store_id);
        // Accept bumps permissionsVersion server-side and the response now
        // embeds the refreshed snapshot directly — patch it in place instead
        // of a full bootstrap round trip. Falls back to refetchUser() if the
        // backend's best-effort embed came back null (rare).
        if (res.snapshot && res.snapshot_signature) {
          useAuthStore.getState().setSnapshot(res.snapshot, res.snapshot_signature);
        } else {
          await refetchUser();
        }
        router.replace('/(app)');
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Could not accept the invitation.';
        Alert.info('Error', message);
      } finally {
        setAcceptingId(null);
      }
    },
    [acceptInvitation, refetchUser],
  );

  const onReject = useCallback(
    (invite: MyInvitationResponse) => {
      Alert.confirm(
        'Decline invitation',
        `Decline the invitation to join ${invite.store_name}?`,
        async () => {
          setRejectingId(invite.id);
          try {
            await rejectInvitation.mutateAsync({ pathParam: { invitationId: invite.id } });
            // Badge/list must reflect this immediately (post-login-onboarding-flow.md
            // §5) — refetch bootstrap so pendingInvitationCount drops right away,
            // not just the local list cache.
            await refetchUser();
            // If that was the last pending invite and there's still no store,
            // there's nothing left to show here — back to the Hub's empty state.
            if ((invitations?.length ?? 0) <= 1) {
              router.replace('/(onboarding)/onboarding-hub');
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : 'Could not decline the invitation.';
            Alert.info('Error', message);
          } finally {
            setRejectingId(null);
          }
        },
        'Decline',
        'destructive',
      );
    },
    [rejectInvitation, refetchUser, invitations],
  );

  const renderInvite = useCallback(
    ({ item: invite }: { item: MyInvitationResponse }) => (
      <InviteCard invite={invite} busy={busyId === invite.id} onAccept={onAccept} onReject={onReject} />
    ),
    [busyId, onAccept, onReject],
  );

  return (
    <AppLayout title="Invitations" onBack={() => router.back()}>
      <ListScaffold<MyInvitationResponse>
        data={invitations ?? []}
        keyExtractor={(i) => i.id}
        renderItem={renderInvite}
        estimatedItemSize={112}
        loaderProps={{
          isLoading,
          isFetching,
          isRefetching,
          loadingCard: () => <InvitationRowSkeleton />,
          loaderLength: 3,
        }}
        listProps={{
          error: isError
            ? { message: 'Something went wrong while checking for invitations.' }
            : undefined,
          refetch,
        }}
        errorState={{ message: "Couldn't load invitations" }}
        emptyState={{
          message: 'No pending invitations',
          description: "Nobody's invited you to a store yet.",
          icon: 'MailX',
        }}
      />
    </AppLayout>
  );
}