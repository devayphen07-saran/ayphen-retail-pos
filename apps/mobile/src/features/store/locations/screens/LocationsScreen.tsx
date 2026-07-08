import { useCallback, useState } from 'react';
import { router } from 'expo-router';
import {
  Alert,
  AppLayout,
  IconButton,
  ListScaffold,
  Typography,
  useBottomSheet,
} from '@ayphen/mobile-ui-components';
import {
  useLocationsQuery,
  useSetDefaultLocationMutation,
  useDeleteLocationMutation,
  useSubscriptionQuery,
} from '@ayphen/api-manager';
import type { LocationResponse } from '@ayphen/api-manager';
import { useActiveStoreStore } from '@store';
import { usePermission } from '@core/auth/usePermission';
import { LocationLoadingCard } from '../loading/LocationsLoading';
import { LocationCard } from '../components/LocationCard';
import { LocationActionsSheet, type LocationActionsSheetProps } from '../components/LocationActionsSheet';

/** Store locations — reached from More > Store Settings > Locations. Real data
 *  via GET stores/:storeId/locations (rbac.md §26.1, adoption §8.2). */
export function LocationsScreen() {
  const storeId = useActiveStoreStore((s) => s.storeId) ?? '';
  const sheet = useBottomSheet();
  const { data: locations, isLoading, isError, isFetching, isRefetching, refetch } =
    useLocationsQuery(storeId, { enabled: !!storeId });
  const setDefault = useSetDefaultLocationMutation(storeId);
  const deleteLocation = useDeleteLocationMutation(storeId);
  // Which row has a set-default/delete in flight — dims + disables just that
  // card instead of spinning the whole screen (loading-agent.md §7).
  const [busyId, setBusyId] = useState<string | null>(null);
  // Local UX gating only — every mutation below is still enforced server-side
  // regardless of these checks (see usePermission.ts / permission-check.ts).
  const canCreateLocation = usePermission('Location', 'create');
  const canEditLocations = usePermission('Location', 'edit');
  const canDeleteLocations = usePermission('Location', 'delete');

  // Reuses the account-level subscription read model's entitlements (already
  // fetched/cached elsewhere in the app) rather than a new endpoint — same
  // limit the server enforces on create (location.service.ts), surfaced here
  // proactively instead of only reactively on a failed create.
  const { data: sub } = useSubscriptionQuery();
  const locationLimit = sub?.plan.entitlements['max_locations_per_store'] ?? null;
  const locationCount = locations?.length ?? 0;
  const atLimit = locationLimit !== null && locationCount >= locationLimit;

  const handleAddPress = useCallback(() => {
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
  }, [atLimit, locationLimit]);

  const editLocation = useCallback((location: LocationResponse) => {
    router.push({ pathname: '/(store)/location-edit', params: { locationId: location.id } });
  }, []);

  const runSetDefault = useCallback(
    async (locationId: string) => {
      setBusyId(locationId);
      try {
        await setDefault.mutateAsync({ pathParam: { storeId, locationId } });
      } catch {
        Alert.info('Error', "Couldn't set this as the default location.");
      } finally {
        setBusyId(null);
      }
    },
    [setDefault, storeId],
  );

  const runDelete = useCallback(
    async (locationId: string) => {
      setBusyId(locationId);
      try {
        await deleteLocation.mutateAsync({ pathParam: { storeId, locationId } });
      } catch {
        Alert.info('Error', "Couldn't delete this location.");
      } finally {
        setBusyId(null);
      }
    },
    [deleteLocation, storeId],
  );

  const confirmDelete = useCallback(
    (location: LocationResponse) => {
      Alert.confirm(
        'Delete location',
        `Delete "${location.name}"? This can't be undone.`,
        () => runDelete(location.id),
        'Delete',
        'destructive',
      );
    },
    [runDelete],
  );

  // A row action menu (Edit / Set default / Delete) belongs in the app's
  // bottom-sheet system, not a raw native Alert — this includes the
  // destructive Delete action, which the sheet still gates behind its own
  // confirm dialog (modal-architecture.md §19/§25).
  const openLocationActions = useCallback(
    (location: LocationResponse) => {
      sheet.open<LocationActionsSheetProps>({
        snapPoint: 'sm',
        title: location.name,
        closeOnBackdrop: true,
        Component: LocationActionsSheet,
        props: {
          location,
          onEdit: editLocation,
          onSetDefault: runSetDefault,
          onDelete: confirmDelete,
          canEdit: canEditLocations,
          canDelete: canDeleteLocations,
        },
      });
    },
    [sheet, editLocation, runSetDefault, confirmDelete, canEditLocations, canDeleteLocations],
  );

  const renderLocation = useCallback(
    ({ item }: { item: LocationResponse }) => (
      <LocationCard location={item} busy={busyId === item.id} onPress={openLocationActions} />
    ),
    [busyId, openLocationActions],
  );

  return (
    <AppLayout
      title="Locations"
      onBack={() => router.back()}
      rightElement={
        canCreateLocation ? (
          <IconButton
            iconName="Plus"
            variant="default"
            accessibilityLabel="Add location"
            onPress={handleAddPress}
          />
        ) : undefined
      }
    >
      <ListScaffold<LocationResponse>
        data={locations ?? []}
        keyExtractor={(l) => l.id}
        renderItem={renderLocation}
        estimatedItemSize={76}
        ListHeaderComponent={
          locationLimit !== null ? (
            <Typography.Caption type="secondary" style={{ paddingBottom: 10 }}>
              {locationCount} of {locationLimit} location{locationLimit === 1 ? '' : 's'} used
            </Typography.Caption>
          ) : null
        }
        loaderProps={{
          isLoading,
          isFetching,
          isRefetching,
          loadingCard: () => <LocationLoadingCard />,
          loaderLength: 4,
        }}
        listProps={{
          error: isError ? { message: "Couldn't load your locations." } : undefined,
          refetch,
          addNew: canCreateLocation ? handleAddPress : undefined,
        }}
        emptyState={{
          message: 'No locations yet',
          description: 'Add a location to start operating from more than one place.',
          icon: 'MapPin',
        }}
      />
    </AppLayout>
  );
}
