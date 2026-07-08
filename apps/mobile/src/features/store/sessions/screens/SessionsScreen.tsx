import { useState } from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';
import { router } from 'expo-router';
import styled from 'styled-components/native';
import { useMobileTheme } from '@ayphen/mobile-theme';
import {
  Alert,
  AppLayout,
  Column,
  LucideIcon,
  Row,
  ScreenStateRenderer,
  SectionHeader,
  Typography,
} from '@ayphen/mobile-ui-components';
import { useSessionsQuery, useRevokeSessionMutation } from '@ayphen/api-manager';
import type { SessionResponse } from '@ayphen/api-manager';
import { useAuth } from '@core/providers/AuthProvider';
import { SessionsLoading } from '../loading/SessionsLoading';
import { timeAgo } from '../utils/time-ago';

function platformIcon(platform: string | null) {
  if (platform === 'ios' || platform === 'android') return 'Smartphone';
  return 'Monitor';
}

function sessionSubtitle(session: SessionResponse): string {
  return [session.os, session.app_version].filter(Boolean).join(' · ');
}

/** Where the user is logged in, across devices — reached from More > System &
 *  Account > Sessions. "This Device" logs out locally + server-side; "Other
 *  Devices" revokes just that session server-side. */
export function SessionsScreen() {
  const { theme } = useMobileTheme();
  const { logout } = useAuth();
  const { data: sessions, isLoading, isError, refetch, isRefetching } = useSessionsQuery();
  const revoke = useRevokeSessionMutation();
  // Which "other" session has a revoke in flight — dims just that card.
  const [busyId, setBusyId] = useState<string | null>(null);

  const all = sessions?.data ?? [];
  const current = all.find((s) => s.is_current);
  const others = all.filter((s) => !s.is_current);

  const runRevoke = async (sessionId: string) => {
    setBusyId(sessionId);
    try {
      await revoke.mutateAsync({ pathParam: { id: sessionId } });
    } catch {
      Alert.info('Error', "Couldn't log out that device.");
    } finally {
      setBusyId(null);
    }
  };

  const confirmLogoutThisDevice = () => {
    Alert.confirm(
      'Log out this device?',
      "You'll need to sign in again to use the app on this device.",
      () => void logout(),
      'Log Out',
      'destructive',
    );
  };

  const confirmRevoke = (session: SessionResponse) => {
    Alert.confirm(
      'Log out this device?',
      `${session.device_name ?? session.platform ?? 'This device'} will be signed out immediately.`,
      () => runRevoke(session.id),
      'Log Out',
      'destructive',
    );
  };

  return (
    <AppLayout title="Sessions" onBack={() => router.back()}>
      <ScrollView
        contentContainerStyle={{ padding: theme.sizing.large, flexGrow: 1 }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={isRefetching && !isLoading} onRefresh={refetch} />
        }
      >
        <ScreenStateRenderer
          isLoading={isLoading}
          isError={isError}
          data={all}
          skeleton={<SessionsLoading />}
          error="Couldn't load your sessions."
          onRetry={() => refetch()}
        >
          {() => (
            <Column gap={20}>
              {current && (
                <Column gap={10}>
                  <SectionHeader title="This Device" containerStyle={{ paddingHorizontal: 0 }} />
                  <SessionCard $accent="primary">
                    <Row align="center" gap={12}>
                      <IconSlot $accent="primary">
                        <LucideIcon
                          name={platformIcon(current.platform)}
                          size={20}
                          color={theme.color.primary.main}
                        />
                      </IconSlot>
                      <Column flex={1} gap={5}>
                        <Typography.Body weight="semiBold" numberOfLines={1}>
                          {current.device_name ?? current.platform ?? 'This device'}
                        </Typography.Body>
                        <Typography.Caption type="secondary">
                          {sessionSubtitle(current)}
                          {sessionSubtitle(current) ? ' · ' : ''}
                          Last used {timeAgo(current.last_used_at)}
                        </Typography.Caption>
                      </Column>
                      <LogOutButton onPress={confirmLogoutThisDevice} activeOpacity={0.7}>
                        <Typography.Caption weight="bold" color={theme.color.danger.main}>
                          Log Out
                        </Typography.Caption>
                      </LogOutButton>
                    </Row>
                  </SessionCard>
                </Column>
              )}

              <Column gap={10}>
                <SectionHeader
                  title={`Other Devices (${others.length})`}
                  containerStyle={{ paddingHorizontal: 0 }}
                />
                {others.length === 0 ? (
                  <Typography.Caption type="secondary">
                    You're not logged in anywhere else.
                  </Typography.Caption>
                ) : (
                  others.map((session) => (
                    <SessionCard
                      key={session.id}
                      $busy={busyId === session.id}
                    >
                      <Row align="center" gap={12}>
                        <IconSlot>
                          <LucideIcon
                            name={platformIcon(session.platform)}
                            size={20}
                            color={theme.colorTextSecondary}
                          />
                        </IconSlot>
                        <Column flex={1} gap={5}>
                          <Typography.Body weight="semiBold" numberOfLines={1}>
                            {session.device_name ?? session.platform ?? 'Unknown device'}
                          </Typography.Body>
                          <Typography.Caption type="secondary">
                            {sessionSubtitle(session)}
                            {sessionSubtitle(session) ? ' · ' : ''}
                            Last used {timeAgo(session.last_used_at)}
                          </Typography.Caption>
                        </Column>
                        <LogOutButton
                          onPress={() => confirmRevoke(session)}
                          activeOpacity={0.7}
                          disabled={busyId === session.id}
                        >
                          <Typography.Caption weight="bold" color={theme.color.danger.main}>
                            Log Out
                          </Typography.Caption>
                        </LogOutButton>
                      </Row>
                    </SessionCard>
                  ))
                )}
              </Column>
            </Column>
          )}
        </ScreenStateRenderer>
      </ScrollView>
    </AppLayout>
  );
}

const SessionCard = styled(View)<{ $accent?: 'primary'; $busy?: boolean }>`
  background-color: ${({ theme }) => theme.colorBgContainer};
  border-radius: ${({ theme }) => theme.borderRadius.xLarge}px;
  border-width: ${({ theme }) => theme.borderWidth.thin}px;
  border-color: ${({ theme }) => theme.colorBorder};
  border-left-width: 3px;
  border-left-color: ${({ theme, $accent }) =>
    $accent === 'primary' ? theme.color.primary.main : 'transparent'};
  padding: ${({ theme }) => theme.sizing.medium}px;
  opacity: ${({ $busy }) => ($busy ? 0.55 : 1)};
  ${({ theme }) => theme.shadow.sm}
`;

const IconSlot = styled(View)<{ $accent?: 'primary' }>`
  width: 44px;
  height: 44px;
  border-radius: ${({ theme }) => theme.borderRadius.large}px;
  align-items: center;
  justify-content: center;
  background-color: ${({ theme, $accent }) =>
    $accent === 'primary' ? theme.color.primary.bg : theme.colorFillSecondary ?? theme.colorBorder};
`;

const LogOutButton = styled.TouchableOpacity`
  padding: 8px 14px;
  border-radius: ${({ theme }) => theme.borderRadius.full}px;
  background-color: ${({ theme }) => theme.color.danger.bg};
`;
