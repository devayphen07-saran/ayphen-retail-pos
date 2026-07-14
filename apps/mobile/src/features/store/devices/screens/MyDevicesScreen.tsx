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
  Tag,
  Typography,
} from '@ayphen/mobile-ui-components';
import {
  useMyDevicesQuery,
  useBlockDeviceMutation,
  useUnblockDeviceMutation,
} from '@ayphen/api-manager';
import type { MyDeviceResponse } from '@ayphen/api-manager';
import { MyDevicesLoading } from '../loading/MyDevicesLoading';
import { timeAgo } from '../utils/time-ago';

function platformIcon(platform: string) {
  if (platform === 'ios') return 'Smartphone';
  if (platform === 'android') return 'Smartphone';
  return 'Monitor';
}

/** Devices registered to the current user, across every store (device-management
 *  §12 F7). Reached from More > System & Account > My Devices. */
export function MyDevicesScreen() {
  const { theme } = useMobileTheme();
  const { data: devices, isLoading, isError, refetch, isRefetching } = useMyDevicesQuery();
  const block = useBlockDeviceMutation();
  const unblock = useUnblockDeviceMutation();
  // Which device has a block/unblock in flight — dims just that card rather
  // than spinning the whole list (loading-agent.md §7).
  const [busyId, setBusyId] = useState<string | null>(null);

  const active = devices?.filter((d) => !d.blocked) ?? [];
  const blocked = devices?.filter((d) => d.blocked) ?? [];

  const runBlock = async (deviceId: string) => {
    setBusyId(deviceId);
    try {
      await block.mutateAsync({ pathParam: { deviceId } });
    } catch {
      Alert.info('Error', "Couldn't block this device.");
    } finally {
      setBusyId(null);
    }
  };

  const runUnblock = async (deviceId: string) => {
    setBusyId(deviceId);
    try {
      await unblock.mutateAsync({ pathParam: { deviceId } });
    } catch {
      Alert.info('Error', "Couldn't unblock this device.");
    } finally {
      setBusyId(null);
    }
  };

  const confirmBlock = (device: MyDeviceResponse) => {
    Alert.confirm(
      'Block this device?',
      `${device.model ?? device.platform}\n\nThis will immediately: sign out all sessions ` +
        `· revoke access to all stores · prevent future login. Local data stays ` +
        `encrypted and cannot be accessed without your login credentials.`,
      () => runBlock(device.device_id),
      'Block Device',
      'destructive',
    );
  };

  const openDeviceActions = (device: MyDeviceResponse) => {
    if (device.blocked) {
      Alert.confirm(
        'Unblock this device?',
        `${device.model ?? device.platform}\n\nYou'll need to log in again on this device, ` +
          `and it will need to re-access each store.`,
        () => runUnblock(device.device_id),
        'Unblock',
      );
      return;
    }
    confirmBlock(device);
  };

  return (
    <AppLayout title="My Devices" onBack={() => router.back()}>
      <ScrollView
        contentContainerStyle={{ flexGrow: 1 }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={isRefetching && !isLoading} onRefresh={refetch} />
        }
      >
        <Column padding={theme.sizing.large}>
        <ScreenStateRenderer
          isLoading={isLoading}
          isError={isError}
          data={devices}
          skeleton={<MyDevicesLoading />}
          error="Couldn't load your devices."
          emptyTitle="No devices"
          emptyDescription="Devices you sign in on will appear here."
          onRetry={() => refetch()}
        >
          {() => (
          <Column gap={20}>
            <Column gap={10}>
              <SectionHeader
                title={`Active Devices (${active.length})`}
                containerStyle={{ paddingHorizontal: theme.sizing.zero }}
              />
              {active.map((device) => (
                <DeviceCard
                  key={device.device_id}
                  onPress={() => openDeviceActions(device)}
                  activeOpacity={0.7}
                  disabled={busyId === device.device_id}
                  $accent={device.is_current ? 'primary' : undefined}
                  $busy={busyId === device.device_id}
                >
                  <Row align="center" gap={12}>
                    <IconSlot $accent={device.is_current ? 'primary' : 'neutral'}>
                      <LucideIcon
                        name={platformIcon(device.platform)}
                        size={20}
                        color={device.is_current ? theme.color.primary.main : theme.colorTextSecondary}
                      />
                    </IconSlot>
                    <Column flex={1} gap={5}>
                      <Row align="center" gap={8}>
                        <Typography.Body weight="semiBold" numberOfLines={1}>
                          {device.model ?? device.platform}
                        </Typography.Body>
                        {device.is_current && <Tag label="This device" variant="info" size="sm" />}
                        {device.trusted && <Tag label="Trusted" variant="success" size="sm" />}
                      </Row>
                      <Typography.Caption type="secondary">
                        {[device.os_version, device.app_version].filter(Boolean).join(' · ')}
                        {device.os_version || device.app_version ? ' · ' : ''}
                        Last seen {timeAgo(device.last_seen_at)}
                      </Typography.Caption>
                      <Row align="center" gap={4}>
                        <LucideIcon name="Store" size={12} color={theme.colorTextTertiary} />
                        <Typography.Caption type="secondary">
                          {device.store_ids.length} store{device.store_ids.length === 1 ? '' : 's'}
                        </Typography.Caption>
                      </Row>
                    </Column>
                    <ChevronSlot>
                      <LucideIcon name="ChevronRight" size={16} color={theme.colorTextTertiary} />
                    </ChevronSlot>
                  </Row>
                </DeviceCard>
              ))}
            </Column>

            {blocked.length > 0 && (
              <Column gap={10}>
                <SectionHeader
                  title={`Blocked Devices (${blocked.length})`}
                  containerStyle={{ paddingHorizontal: theme.sizing.zero }}
                />
                {blocked.map((device) => (
                  <DeviceCard
                    key={device.device_id}
                    onPress={() => openDeviceActions(device)}
                    activeOpacity={0.7}
                    disabled={busyId === device.device_id}
                    $accent="danger"
                    $busy={busyId === device.device_id}
                  >
                    <Row align="center" gap={12}>
                      <IconSlot $accent="danger">
                        <LucideIcon name="ShieldOff" size={20} color={theme.color.danger.main} />
                      </IconSlot>
                      <Column flex={1} gap={5}>
                        <Row align="center" gap={8}>
                          <Typography.Body weight="semiBold" color={theme.colorTextSecondary} numberOfLines={1}>
                            {device.model ?? device.platform}
                          </Typography.Body>
                          <Tag label="Blocked" variant="danger" size="sm" />
                        </Row>
                        <Typography.Caption type="secondary">
                          Signed out everywhere · tap to unblock
                        </Typography.Caption>
                      </Column>
                      <ChevronSlot>
                        <LucideIcon name="ChevronRight" size={16} color={theme.colorTextTertiary} />
                      </ChevronSlot>
                    </Row>
                  </DeviceCard>
                ))}
              </Column>
            )}
          </Column>
          )}
        </ScreenStateRenderer>
        </Column>
      </ScrollView>
    </AppLayout>
  );
}

type CardAccent = 'primary' | 'danger';

const DeviceCard = styled.TouchableOpacity<{ $accent?: CardAccent; $busy?: boolean }>`
  background-color: ${({ theme, $accent }) =>
    $accent === 'danger' ? theme.color.danger.bg : theme.colorBgContainer};
  border-radius: ${({ theme }) => theme.borderRadius.xLarge}px;
  border-width: ${({ theme }) => theme.borderWidth.thin}px;
  border-color: ${({ theme, $accent }) =>
    $accent === 'danger' ? theme.color.danger.border : theme.colorBorder};
  border-left-width: ${({ theme }) => theme.borderWidth.medium}px;
  border-left-color: ${({ theme, $accent }) =>
    // 'transparent' is a CSS keyword, not a design value — no theme token needed.
    $accent === 'primary'
      ? theme.color.primary.main
      : $accent === 'danger'
        ? theme.color.danger.main
        : 'transparent'};
  padding: ${({ theme }) => theme.sizing.medium}px;
  opacity: ${({ $busy }) => ($busy ? 0.55 : 1)};
  ${({ theme, $accent }) => ($accent === 'danger' ? '' : theme.shadow.sm)}
`;

const IconSlot = styled(View)<{ $accent?: CardAccent | 'neutral' }>`
  /* 44px is an un-tokenized icon-slot size — no matching theme.componentSizing entry. */
  width: 44px;
  height: 44px;
  border-radius: ${({ theme }) => theme.borderRadius.large}px;
  align-items: center;
  justify-content: center;
  background-color: ${({ theme, $accent }) =>
    $accent === 'danger'
      ? theme.color.danger.bg
      : $accent === 'primary'
        ? theme.color.primary.bg
        : theme.colorFillSecondary ?? theme.colorBorder};
`;

const ChevronSlot = styled(View)`
  /* 28px is an un-tokenized chevron-slot size — no matching theme.componentSizing entry. */
  width: 28px;
  height: 28px;
  border-radius: ${({ theme }) => theme.borderRadius.full}px;
  align-items: center;
  justify-content: center;
  background-color: ${({ theme }) => theme.colorFillSecondary ?? theme.colorBgLayout};
`;
