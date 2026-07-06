import { useState } from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';
import type { AlertButton } from 'react-native';
import { router } from 'expo-router';
import styled from 'styled-components/native';
import { useMobileTheme } from '@ayphen/mobile-theme';
import {
  Alert,
  AppLayout,
  Column,
  IconButton,
  LucideIcon,
  Row,
  ScreenStateRenderer,
  Tag,
  Typography,
} from '@ayphen/mobile-ui-components';
import {
  useLocationsQuery,
  useSetDefaultLocationMutation,
  useDeleteLocationMutation,
  useSubscriptionQuery,
} from '@ayphen/api-manager';
import type { LocationResponse } from '@ayphen/api-manager';
import { useActiveStoreStore } from '@store';
import { LocationsLoading } from '../loading/LocationsLoading';

/** Store locations — reached from More > Store Settings > Locations. Real data
 *  via GET stores/:storeId/locations (rbac.md §26.1, adoption §8.2). */
export function LocationsScreen() {
  const { theme } = useMobileTheme();
  const storeId = useActiveStoreStore((s) => s.storeId) ?? '';
  const { data: locations, isLoading, isError, refetch, isRefetching } = useLocationsQuery(storeId, {
    enabled: !!storeId,
  });
  const setDefault = useSetDefaultLocationMutation(storeId);
  const deleteLocation = useDeleteLocationMutation(storeId);
  // Which row has a set-default/delete in flight — dims + disables just that
  // card instead of spinning the whole screen (loading-agent.md §7).
  const [busyId, setBusyId] = useState<string | null>(null);

  // Reuses the account-level subscription read model's entitlements (already
  // fetched/cached elsewhere in the app) rather than a new endpoint — same
  // limit the server enforces on create (location.service.ts), surfaced here
  // proactively instead of only reactively on a failed create.
  const { data: sub } = useSubscriptionQuery();
  const locationLimit = sub?.plan.entitlements['max_locations_per_store'] ?? null;
  const locationCount = locations?.length ?? 0;
  const atLimit = locationLimit !== null && locationCount >= locationLimit;

  const handleAddPress = () => {
    if (atLimit) {
      Alert.confirm(
        "You've reached your plan's location limit",
        `Your plan allows ${locationLimit} location${locationLimit === 1 ? '' : 's'} per store. Upgrade to add more.`,
        () => router.push('/(store)/subscription-plans'),
        'View plans',
      );
      return;
    }
    router.push('/(store)/location-create');
  };

  const editLocation = (location: LocationResponse) => {
    router.push({
      pathname: '/(store)/location-edit',
      params: {
        locationId: location.id,
        name:       location.name,
        enable:     String(location.enable),
        isPrimary:  String(location.is_primary),
        isDefault:  String(location.is_default),
      },
    });
  };

  const runSetDefault = async (locationId: string) => {
    setBusyId(locationId);
    try {
      await setDefault.mutateAsync({ pathParam: { storeId, locationId } });
    } catch {
      Alert.info('Error', "Couldn't set this as the default location.");
    } finally {
      setBusyId(null);
    }
  };

  const runDelete = async (locationId: string) => {
    setBusyId(locationId);
    try {
      await deleteLocation.mutateAsync({ pathParam: { storeId, locationId } });
    } catch {
      Alert.info('Error', "Couldn't delete this location.");
    } finally {
      setBusyId(null);
    }
  };

  const openLocationActions = (location: LocationResponse) => {
    const buttons: AlertButton[] = [
      { text: 'Edit', onPress: () => editLocation(location) },
    ];
    if (!location.is_default) {
      buttons.push({ text: 'Set as default', onPress: () => runSetDefault(location.id) });
    }
    if (!location.is_primary) {
      buttons.push({
        text: 'Delete',
        style: 'destructive',
        onPress: () =>
          Alert.confirm(
            'Delete location',
            `Delete "${location.name}"? This can't be undone.`,
            () => runDelete(location.id),
            'Delete',
            'destructive',
          ),
      });
    }
    buttons.push({ text: 'Cancel', style: 'cancel' });
    Alert.show(location.name, undefined, buttons);
  };

  return (
    <AppLayout
      title="Locations"
      onBack={() => router.back()}
      rightElement={
        <IconButton
          iconName="Plus"
          variant="default"
          accessibilityLabel="Add location"
          onPress={handleAddPress}
        />
      }
    >
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
          data={locations}
          skeleton={<LocationsLoading />}
          error="Couldn't load your locations."
          emptyTitle="No locations yet"
          emptyDescription="Add a location to start operating from more than one place."
          emptyAction={{ label: 'Add location', onPress: handleAddPress }}
          onRetry={() => refetch()}
        >
          {() => (
          <Column gap={10}>
            {locationLimit !== null && (
              <Typography.Caption type="secondary">
                {locationCount} of {locationLimit} location{locationLimit === 1 ? '' : 's'} used
              </Typography.Caption>
            )}
            {locations?.map((location) => (
              <LocationCard
                key={location.id}
                onPress={() => openLocationActions(location)}
                activeOpacity={0.7}
                disabled={busyId === location.id}
                $disabled={!location.enable || busyId === location.id}
              >
                <Row align="center" gap={12}>
                  <IconSlot $disabled={!location.enable}>
                    <LucideIcon
                      name="MapPin"
                      size={20}
                      color={location.enable ? theme.colorPrimary : theme.colorTextTertiary}
                    />
                  </IconSlot>
                  <Column flex={1} gap={4}>
                    <Typography.Body
                      weight="medium"
                      color={location.enable ? undefined : theme.colorTextTertiary}
                    >
                      {location.name}
                    </Typography.Body>
                    <Row gap={6}>
                      {location.is_primary && (
                        <Tag label="Head Office" variant="info" size="sm" />
                      )}
                      {location.is_default && (
                        <Tag label="Default" variant="success" size="sm" />
                      )}
                      {!location.enable && (
                        <Tag label="Disabled" variant="default" size="sm" />
                      )}
                      {location.is_locked && (
                        <Tag label="Locked — plan downgrade" variant="danger" size="sm" />
                      )}
                    </Row>
                  </Column>
                  <LucideIcon name="ChevronRight" size={16} color={theme.colorTextTertiary} />
                </Row>
              </LocationCard>
            ))}
          </Column>
          )}
        </ScreenStateRenderer>
      </ScrollView>
    </AppLayout>
  );
}

function locationRowStyle(disabled: boolean) {
  return disabled ? { opacity: 0.55 } : undefined;
}

const LocationCard = styled.TouchableOpacity.attrs<{ $disabled?: boolean }>((props) => ({
  style: locationRowStyle(!!props.$disabled),
}))<{ $disabled?: boolean }>`
  background-color: ${({ theme }) => theme.colorBgContainer};
  border-radius: ${({ theme }) => theme.borderRadius.xLarge}px;
  border-width: ${({ theme }) => theme.borderWidth.thin}px;
  border-color: ${({ theme }) => theme.colorBorder};
  padding: ${({ theme }) => theme.sizing.medium}px;
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
