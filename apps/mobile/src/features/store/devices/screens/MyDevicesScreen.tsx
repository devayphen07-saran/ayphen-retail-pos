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

function platformIcon(platform: string) {
  if (platform === 'ios') return 'Smartphone';
  if (platform === 'android') return 'Smartphone';
  return 'Monitor';
}

function timeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'Now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
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
        contentContainerStyle={{ padding: theme.sizing.large, flexGrow: 1 }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={isRefetching && !isLoading} onRefresh={refetch} />
        }
      >
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
          <Column gap={16}>
            <Column gap={10}>
              {active.map((device) => (
                <DeviceCard
                  key={device.device_id}
                  onPress={() => openDeviceActions(device)}
                  activeOpacity={0.7}
                  disabled={busyId === device.device_id}
                  $disabled={busyId === device.device_id}
                >
                  <Row align="center" gap={12}>
                    <IconSlot>
                      <LucideIcon
                        name={platformIcon(device.platform)}
                        size={20}
                        color={theme.colorPrimary}
                      />
                    </IconSlot>
                    <Column flex={1} gap={4}>
                      <Typography.Body weight="medium">
                        {device.model ?? device.platform}
                      </Typography.Body>
                      <Typography.Caption type="secondary">
                        {[device.os_version, device.app_version].filter(Boolean).join(' · ')}
                        {device.os_version || device.app_version ? ' · ' : ''}
                        Last seen: {timeAgo(device.last_seen_at)}
                      </Typography.Caption>
                      <Row gap={6}>
                        {device.is_current && <Tag label="This device" variant="info" size="sm" />}
                        {device.trusted && <Tag label="Trusted" variant="success" size="sm" />}
                        <Typography.Caption type="secondary">
                          {device.store_ids.length} store{device.store_ids.length === 1 ? '' : 's'}
                        </Typography.Caption>
                      </Row>
                    </Column>
                    <LucideIcon name="ChevronRight" size={16} color={theme.colorTextTertiary} />
                  </Row>
                </DeviceCard>
              ))}
            </Column>

            {blocked.length > 0 && (
              <Column gap={10}>
                <Typography.Caption type="secondary">BLOCKED</Typography.Caption>
                {blocked.map((device) => (
                  <DeviceCard
                    key={device.device_id}
                    onPress={() => openDeviceActions(device)}
                    activeOpacity={0.7}
                    disabled={busyId === device.device_id}
                    $disabled
                  >
                    <Row align="center" gap={12}>
                      <IconSlot $disabled>
                        <LucideIcon name="ShieldOff" size={20} color={theme.colorError} />
                      </IconSlot>
                      <Column flex={1} gap={4}>
                        <Typography.Body weight="medium" color={theme.colorTextTertiary}>
                          {device.model ?? device.platform}
                        </Typography.Body>
                        <Row gap={6}>
                          <Tag label="Blocked" variant="danger" size="sm" />
                        </Row>
                      </Column>
                      <LucideIcon name="ChevronRight" size={16} color={theme.colorTextTertiary} />
                    </Row>
                  </DeviceCard>
                ))}
              </Column>
            )}
          </Column>
          )}
        </ScreenStateRenderer>
      </ScrollView>
    </AppLayout>
  );
}

const DeviceCard = styled.TouchableOpacity<{ $disabled?: boolean }>`
  background-color: ${({ theme }) => theme.colorBgContainer};
  border-radius: ${({ theme }) => theme.borderRadius.xLarge}px;
  border-width: ${({ theme }) => theme.borderWidth.thin}px;
  border-color: ${({ theme }) => theme.colorBorder};
  padding: ${({ theme }) => theme.sizing.medium}px;
  opacity: ${({ $disabled }) => ($disabled ? 0.7 : 1)};
`;

const IconSlot = styled(View)<{ $disabled?: boolean }>`
  width: 40px;
  height: 40px;
  border-radius: ${({ theme }) => theme.borderRadius.large}px;
  align-items: center;
  justify-content: center;
  background-color: ${({ theme, $disabled }) =>
    $disabled ? theme.colorFillSecondary ?? theme.colorBorder : `${theme.colorPrimary}15`};
`;
