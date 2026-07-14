import { RefreshControl, ScrollView } from 'react-native';
import { router } from 'expo-router';
import styled from 'styled-components/native';
import { useMobileTheme } from '@ayphen/mobile-theme';
import {
  AppLayout,
  Avatar,
  Column,
  ListRow,
  ScreenStateRenderer,
  Typography,
} from '@ayphen/mobile-ui-components';
import { useProfileQuery, type ProfileResponse } from '@ayphen/api-manager';
import { ProfileLoading } from '../loading/ProfileLoading';

/** Initials from a full name — "Asha Rao" → "AR", "asha" → "A". */
function initialsFrom(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0]!.slice(0, 1).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

/**
 * My Profile — view-only for now (device-management/profile §1 slice 1).
 * Reached from the store home header's "Profile" icon, which previously
 * routed to More since this screen didn't exist. Avatar upload, and an
 * "add email" action, are deliberately NOT here yet: avatar needs the
 * attachment/storage work landed first, and letting a user attach an
 * unverified second contact channel would be a trust-boundary hole this app
 * has no email-verification infra to back yet — see profile-flow design.
 */
export function ProfileScreen() {
  const { theme } = useMobileTheme();
  const { data: profile, isLoading, isError, refetch, isRefetching } = useProfileQuery();
  const scrollContentStyle = { padding: theme.sizing.large, flexGrow: 1 };

  return (
    <AppLayout title="My Profile" onBack={() => router.back()}>
      <ScrollView
        contentContainerStyle={scrollContentStyle}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={isRefetching && !isLoading} onRefresh={refetch} />
        }
      >
        <ScreenStateRenderer<ProfileResponse>
          isLoading={isLoading}
          isError={isError}
          data={profile}
          skeleton={<ProfileLoading />}
          error="Couldn't load your profile."
          onRetry={() => refetch()}
        >
          {(data) => {
            // ScreenStateRenderer's children type covers both the single-item
            // and list-data cases it's generically built for; this endpoint
            // only ever returns a single ProfileResponse, never an array.
            const p = data as ProfileResponse;
            return (
            <Column gap={theme.sizing.large} align="center">
              <Avatar
                uri={p.profile_picture_url ?? undefined}
                initials={p.profile_picture_url ? undefined : initialsFrom(p.name)}
                size={88}
                accessibilityLabel={`${p.name}'s profile picture`}
              />
              <Typography.H4 color={theme.colorText}>{p.name}</Typography.H4>

              <Column gap={theme.sizing.small} width="100%">
                <ProfileListRow
                  icon="Mail"
                  title="Email"
                  subtitle={p.email ?? 'Not added'}
                  chevron={false}
                />
                <ProfileListRow
                  icon="Phone"
                  title="Phone"
                  subtitle={
                    p.phone
                      ? `${p.phone}${p.phone_verified ? ' · Verified' : ''}`
                      : 'Not added'
                  }
                  chevron={false}
                />
              </Column>
            </Column>
            );
          }}
        </ScreenStateRenderer>
      </ScrollView>
    </AppLayout>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const ProfileListRow = styled(ListRow)`
  background-color: ${({ theme }) => theme.colorBgContainer};
  border-radius: ${({ theme }) => theme.borderRadius.xLarge}px;
  border-width: ${({ theme }) => theme.borderWidth.thin}px;
  border-color: ${({ theme }) => theme.colorBorderSecondary};
  padding-horizontal: ${({ theme }) => theme.sizing.medium}px;
`;
