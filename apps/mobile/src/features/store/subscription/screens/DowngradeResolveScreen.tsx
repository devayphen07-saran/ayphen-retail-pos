import { useEffect, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { router } from 'expo-router';
import styled from 'styled-components/native';
import { useMobileTheme } from '@ayphen/mobile-theme';
import {
  Alert,
  AppLayout,
  Button,
  CheckBox,
  Column,
  Row,
  ScreenStateRenderer,
  Tag,
  Typography,
} from '@ayphen/mobile-ui-components';
import {
  useReconciliationQuery,
  useResolveReconciliationMutation,
  type ReconciliationResponse,
} from '@ayphen/api-manager';
import { DowngradeResolveLoading } from '../loading/DowngradeResolveLoading';

function timeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'Now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * The downgrade resolve screen — the owner picks which stores/locations/
 * devices to keep after a plan change left the account over limit
 * (subscription §15D, device-management §19). Nothing here is auto-picked;
 * the account stays in `reconciliation_status='pending'` (every write
 * blocked account-wide) until this is submitted. Head Office never appears
 * as a lockable choice — it's immune, always kept implicitly.
 */
export function DowngradeResolveScreen() {
  const { theme } = useMobileTheme();
  const { data: ctx, isLoading, isError, refetch } = useReconciliationQuery();
  const resolve = useResolveReconciliationMutation();

  const [keepStoreIds, setKeepStoreIds] = useState<Set<string>>(new Set());
  const [keepLocationIds, setKeepLocationIds] = useState<Set<string>>(new Set());
  const [keepDeviceIds, setKeepDeviceIds] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);

  // The store the owner is using this screen from — must never end up
  // excluded (by default seed or by hand): dropping it signs this device out
  // of the only store it could use to fix things.
  const currentDeviceStoreId = ctx?.devices.find((d) => d.is_current_device)?.store_id;

  // Seed a sensible starting selection once: keep the first `maxStores`
  // stores, current-device's store prioritized first (never bumped out by
  // the slice below), and within each, the first `maxLocations` non-primary
  // locations and first `maxDevices` devices (current device prioritized).
  // The owner can change any of it before submitting — this is just a
  // reasonable default, not a silent auto-apply.
  useEffect(() => {
    if (!ctx) return;
    const orderedStores = [...ctx.stores].sort((a, b) => {
      const aCurrent = a.id === currentDeviceStoreId;
      const bCurrent = b.id === currentDeviceStoreId;
      return aCurrent === bCurrent ? 0 : aCurrent ? -1 : 1;
    });
    const storeIds = ctx.limits.max_stores === null
      ? orderedStores.map((s) => s.id)
      : orderedStores.slice(0, ctx.limits.max_stores).map((s) => s.id);
    setKeepStoreIds(new Set(storeIds));

    const locationIds = new Set<string>();
    const deviceIds = new Set<string>();
    for (const storeId of storeIds) {
      const storeLocations = ctx.locations.filter((l) => l.store_id === storeId && !l.is_primary);
      const kept = ctx.limits.max_locations === null
        ? storeLocations
        : storeLocations.slice(0, ctx.limits.max_locations - 1); // -1: primary always counts as slot 1
      kept.forEach((l) => locationIds.add(l.id));

      const storeDevices = ctx.devices.filter((d) => d.store_id === storeId);
      const sorted = [...storeDevices].sort((a, b) =>
        a.is_current_device === b.is_current_device ? 0 : a.is_current_device ? -1 : 1,
      );
      const keptDevices = ctx.limits.max_devices === null
        ? sorted
        : sorted.slice(0, ctx.limits.max_devices);
      keptDevices.forEach((d) => deviceIds.add(d.id));
    }
    setKeepLocationIds(locationIds);
    setKeepDeviceIds(deviceIds);
    // currentDeviceStoreId is derived from ctx itself — re-deriving it here
    // on every ctx change is what we want, not an extra dependency to track.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx]);

  const toggleStore = (storeId: string, next: boolean) => {
    setKeepStoreIds((prev) => {
      const copy = new Set(prev);
      if (next) copy.add(storeId); else copy.delete(storeId);
      return copy;
    });
  };

  const toggleLocation = (locationId: string, next: boolean) => {
    setKeepLocationIds((prev) => {
      const copy = new Set(prev);
      if (next) copy.add(locationId); else copy.delete(locationId);
      return copy;
    });
  };

  const toggleDevice = (deviceId: string, next: boolean) => {
    setKeepDeviceIds((prev) => {
      const copy = new Set(prev);
      if (next) copy.add(deviceId); else copy.delete(deviceId);
      return copy;
    });
  };

  const onSubmit = async () => {
    if (!ctx) return;
    if (ctx.limits.max_stores !== null && keepStoreIds.size > ctx.limits.max_stores) {
      Alert.info('Too many stores selected', `Your plan allows ${ctx.limits.max_stores}.`);
      return;
    }
    setSubmitting(true);
    try {
      await resolve.mutateAsync({
        bodyParam: {
          keep_store_ids: [...keepStoreIds],
          keep_location_ids: [...keepLocationIds],
          keep_device_ids: [...keepDeviceIds],
        },
      });
      Alert.info('Done', 'Your plan has been resolved.');
      router.back();
    } catch {
      Alert.info('Error', "Couldn't save your selection. Check the counts against your plan limits.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AppLayout title="Resolve your plan" onBack={() => router.back()}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: theme.sizing.large, flexGrow: 1, paddingBottom: 100 }}
        showsVerticalScrollIndicator={false}
      >
        <ScreenStateRenderer<ReconciliationResponse>
          isLoading={isLoading}
          isError={isError}
          data={ctx}
          skeleton={<DowngradeResolveLoading />}
          error="Couldn't load your plan details."
          onRetry={() => refetch()}
        >
          {(data) => {
            // Narrow the single object back (renderer widens to `T | T[]`);
            // this screen unblocks an account-wide write freeze, so a load
            // failure must offer a retry, never strand on a dead message.
            const ctx = data as ReconciliationResponse;
            return (
          <Column gap={16}>
            <Typography.Caption type="secondary">
              Your plan changed and some stores, locations, or devices are over the new limit.
              Choose what to keep — everything else is locked, not deleted, and you can undo this
              anytime by upgrading or removing something else.
            </Typography.Caption>

            <Section>
              <Typography.Subtitle weight="bold">
                Stores {ctx.limits.max_stores !== null ? `(keep up to ${ctx.limits.max_stores})` : ''}
              </Typography.Subtitle>
              <Column gap={8}>
                {ctx.stores.map((store) => {
                  const isCurrentDeviceStore = store.id === currentDeviceStoreId;
                  return (
                    <Row key={store.id} align="center" justify="space-between">
                      <Column flex={1}>
                        <Row align="center" gap={6}>
                          <Typography.Body weight="medium">{store.name}</Typography.Body>
                          {isCurrentDeviceStore && <Tag label="This device" variant="info" size="sm" />}
                        </Row>
                        <Typography.Caption type="secondary">
                          {store.location_count} location{store.location_count === 1 ? '' : 's'} ·{' '}
                          {store.device_count} device{store.device_count === 1 ? '' : 's'}
                        </Typography.Caption>
                      </Column>
                      <CheckBox
                        value={isCurrentDeviceStore || keepStoreIds.has(store.id)}
                        onValueChange={(next) => toggleStore(store.id, next)}
                        disabled={isCurrentDeviceStore}
                        size={16}
                      />
                    </Row>
                  );
                })}
              </Column>
            </Section>

            {ctx.stores.filter((s) => keepStoreIds.has(s.id)).map((store) => {
              const storeLocations = ctx.locations.filter((l) => l.store_id === store.id);
              const storeDevices = ctx.devices.filter((d) => d.store_id === store.id);
              return (
                <Section key={store.id}>
                  <Typography.Subtitle weight="bold">{store.name}</Typography.Subtitle>

                  {storeLocations.length > 0 && (
                    <Column gap={8}>
                      <Typography.Caption type="secondary">
                        Locations{ctx.limits.max_locations !== null ? ` (keep up to ${ctx.limits.max_locations})` : ''}
                      </Typography.Caption>
                      {storeLocations.map((loc) => (
                        <Row key={loc.id} align="center" justify="space-between">
                          <Row align="center" gap={6}>
                            <Typography.Body>{loc.name}</Typography.Body>
                            {loc.is_primary && <Tag label="Head Office" variant="info" size="sm" />}
                          </Row>
                          <CheckBox
                            value={loc.is_primary || keepLocationIds.has(loc.id)}
                            onValueChange={(next) => toggleLocation(loc.id, next)}
                            disabled={loc.is_primary}
                            size={16}
                          />
                        </Row>
                      ))}
                    </Column>
                  )}

                  {storeDevices.length > 0 && (
                    <Column gap={8}>
                      <Typography.Caption type="secondary">
                        Devices{ctx.limits.max_devices !== null ? ` (keep up to ${ctx.limits.max_devices})` : ''}
                      </Typography.Caption>
                      {storeDevices.map((device) => (
                        <Row key={device.id} align="center" justify="space-between">
                          <Column flex={1}>
                            <Row align="center" gap={6}>
                              <Typography.Body>{device.label ?? device.model ?? device.platform}</Typography.Body>
                              {device.is_current_device && <Tag label="This device" variant="info" size="sm" />}
                            </Row>
                            <Typography.Caption type="secondary">
                              Last active: {timeAgo(device.last_accessed_at)}
                            </Typography.Caption>
                          </Column>
                          <CheckBox
                            value={keepDeviceIds.has(device.id)}
                            onValueChange={(next) => toggleDevice(device.id, next)}
                            disabled={device.is_current_device}
                            size={16}
                          />
                        </Row>
                      ))}
                    </Column>
                  )}
                </Section>
              );
            })}
          </Column>
            );
          }}
        </ScreenStateRenderer>
      </ScrollView>
      {!isLoading && !isError && !!ctx && (
        <FooterBar>
          <Button label="Save" variant="primary" loading={submitting} onPress={onSubmit} />
        </FooterBar>
      )}
    </AppLayout>
  );
}

const Section = styled(View)`
  gap: ${({ theme }) => theme.sizing.medium}px;
  background-color: ${({ theme }) => theme.colorBgContainer};
  border-radius: ${({ theme }) => theme.borderRadius.xLarge}px;
  border-width: ${({ theme }) => theme.borderWidth.thin}px;
  border-color: ${({ theme }) => theme.colorBorder};
  padding: ${({ theme }) => theme.sizing.medium}px;
`;

const FooterBar = styled(View)`
  padding: ${({ theme }) => theme.sizing.large}px;
  padding-bottom: ${({ theme }) => theme.sizing.xxLarge}px;
  background-color: ${({ theme }) => theme.colorBgContainer};
  border-top-width: ${({ theme }) => theme.borderWidth.thin}px;
  border-top-color: ${({ theme }) => theme.colorBorderSecondary};
`;
