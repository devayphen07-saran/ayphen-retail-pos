import { useCallback, useState } from 'react';
import { RefreshControl, ScrollView } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import styled from 'styled-components/native';
import { useMobileTheme } from '@ayphen/mobile-theme';
import {
  Alert,
  AppLayout,
  Button,
  Column,
  ListRow,
  NoDataContainer,
  Row,
  SkeletonBox,
} from '@ayphen/mobile-ui-components';
import {
  useMyInvitationsQuery,
  useAcceptInvitationByIdMutation,
  useRejectInvitationByIdMutation,
  type MyInvitationResponse,
} from '@ayphen/api-manager';
import { setLastOpenedStoreId } from '@features/store/shared/utils/prefs';
import { useAuth } from '@core/providers/AuthProvider';

/** Matches ListRow's shape (icon slot + title + subtitle) so there's zero
 *  layout shift when data replaces the skeleton (loading-agent.md §2). */
function InvitationRowSkeleton() {
  return (
    <Row align="center" gap={12} padding="xSmall">
      <SkeletonBox width={40} height={40} borderRadius={20} />
      <Column flex={1} gap={6}>
        <SkeletonBox width="58%" height={13} />
        <SkeletonBox width="36%" height={10} />
      </Column>
    </Row>
  );
}

/** Reached from the Onboarding Hub's invite banner/badge — accept or reject
 *  a pending invitation (post-login-onboarding-flow.md §4). */
export function InvitationsScreen() {
  const { theme } = useMobileTheme();
  const { refetchUser } = useAuth();
  const {
    data: invitations,
    isLoading,
    isError,
    refetch,
    isRefetching,
  } = useMyInvitationsQuery();
  const acceptInvitation = useAcceptInvitationByIdMutation();
  const rejectInvitation = useRejectInvitationByIdMutation();
  const [acceptingId, setAcceptingId] = useState<string | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const busyId = acceptingId ?? rejectingId;
  const hasData = (invitations?.length ?? 0) > 0;

  // Refetch whenever this screen regains focus (loading-agent.md §12), e.g.
  // returning here after creating/joining a store elsewhere in the stack.
  useFocusEffect(
    useCallback(() => {
      refetch();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
  );

  const onAccept = async (invite: MyInvitationResponse) => {
    setAcceptingId(invite.id);
    try {
      const res = await acceptInvitation.mutateAsync({ pathParam: { id: invite.id } });
      await setLastOpenedStoreId(res.store_id);
      // Accept bumps permissionsVersion server-side — refetch bootstrap so the
      // new store shows up in the snapshot before the gate re-evaluates.
      await refetchUser();
      router.replace('/(app)');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not accept the invitation.';
      Alert.info('Error', message);
    } finally {
      setAcceptingId(null);
    }
  };

  const onReject = (invite: MyInvitationResponse) => {
    Alert.confirm(
      'Decline invitation',
      `Decline the invitation to join ${invite.store_name}?`,
      async () => {
        setRejectingId(invite.id);
        try {
          await rejectInvitation.mutateAsync({ pathParam: { id: invite.id } });
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
  };

  return (
    <AppLayout title="Invitations" onBack={() => router.back()}>
      <ScrollView
        contentContainerStyle={{ padding: theme.sizing.large, flexGrow: 1 }}
        refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={refetch} />}
      >
        {isLoading && !hasData ? (
          // First visit, no cache, known layout (a list of ListRow-shaped
          // invitation cards) — skeleton matching that shape (loading-agent.md §2).
          <Column gap={4}>
            {Array.from({ length: 3 }).map((_, idx) => (
              <InvitationRowSkeleton key={idx} />
            ))}
          </Column>
        ) : isError && !hasData ? (
          <NoDataContainer
            iconName="TriangleAlert"
            message="Couldn't load invitations"
            description="Something went wrong while checking for invitations."
            buttonProps={{ buttonText: 'Retry', onPress: () => refetch() }}
          />
        ) : !hasData ? (
          <NoDataContainer
            message="No pending invitations"
            description="Nobody's invited you to a store yet."
          />
        ) : (
          <Column gap={10}>
            {invitations?.map((invite) => {
              const isBusy = busyId === invite.id;
              return (
                <InviteCard
                  key={invite.id}
                  style={isBusy ? { opacity: 0.5 } : undefined}
                >
                  <ListRow
                    icon="Store"
                    title={invite.store_name}
                    subtitle={`Invited as ${invite.role_name}`}
                    chevron={false}
                  />
                  <Row gap={8}>
                    <Button
                      label="Decline"
                      variant="dashed"
                      disabled={isBusy}
                      onPress={() => onReject(invite)}
                      accessibilityLabel={`Decline invitation to ${invite.store_name}`}
                      style={{ flex: 1 }}
                    />
                    <Button
                      label="Accept"
                      variant="default"
                      disabled={isBusy}
                      onPress={() => onAccept(invite)}
                      accessibilityLabel={`Accept invitation to ${invite.store_name}`}
                      style={{ flex: 1 }}
                    />
                  </Row>
                </InviteCard>
              );
            })}
          </Column>
        )}
      </ScrollView>
    </AppLayout>
  );
}

const InviteCard = styled.View`
  border-radius: 16px;
  border-width: ${({ theme }) => theme.borderWidth.thin}px;
  border-color: ${({ theme }) => theme.colorBorderSecondary};
  padding: ${({ theme }) => theme.sizing.small}px;
  gap: ${({ theme }) => theme.sizing.small}px;
`;
