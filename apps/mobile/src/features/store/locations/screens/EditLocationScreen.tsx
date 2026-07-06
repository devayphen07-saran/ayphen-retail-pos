import { useMemo } from 'react';
import { ActivityIndicator, View } from 'react-native';
import styled from 'styled-components/native';
import { useLocalSearchParams } from 'expo-router';
import { useMobileTheme } from '@ayphen/mobile-theme';
import { AppLayout, Button, Column, Input, Switch, Typography } from '@ayphen/mobile-ui-components';
import { useLocationsQuery, useUpdateLocationMutation } from '@ayphen/api-manager';
import { useActiveStoreStore } from '@store';
import { FormScreen } from '../../../../components/FormScreen';
import { editLocationSchema, type EditLocationForm } from '../types/schema';
import { toUpdateLocationPayload } from '../utils/transform';

type Params = { locationId: string };

/**
 * Rename / enable-disable an existing location. Separate from
 * CreateLocationScreen because create's `is_default` toggle and edit's `enable`
 * toggle are different backend contracts (Create vs Update DTO) — a documented
 * §11A structural split. Both screens share FormScreen, so the form behavior is
 * identical.
 *
 * Only `locationId` travels through params (navigation-agent.md golden rule
 * 3) — the row itself is read fresh from `useLocationsQuery`'s cache (the
 * same cache `LocationsScreen` populates and every location mutation
 * invalidates), not trusted from the tap that navigated here. There's no
 * GET-single-location endpoint, but the list query is already the single
 * source of truth every other location screen reads from, so deriving from
 * it here (instead of frozen params) means a concurrent edit from another
 * device is reflected the moment this screen mounts, not stuck at whatever
 * the list looked like when the user tapped the row.
 */
export function EditLocationScreen() {
  const { theme } = useMobileTheme();
  const { locationId } = useLocalSearchParams<Params>();
  const storeId = useActiveStoreStore((s) => s.storeId) ?? '';
  const updateLocation = useUpdateLocationMutation(storeId);
  const { data: locations, isLoading, isError, refetch } = useLocationsQuery(storeId);

  const location = useMemo(() => locations?.find((l) => l.id === locationId), [locations, locationId]);
  const enableLocked = !!location && (location.is_primary || location.is_default);

  if (isLoading) {
    return (
      <AppLayout title="Edit Location">
        <Column gap={3} align="center" justify="center" flex={1}>
          <ActivityIndicator color={theme.colorPrimary} size="large" />
        </Column>
      </AppLayout>
    );
  }

  if (isError || !location) {
    return (
      <AppLayout title="Edit Location">
        <Column gap={3} align="center" justify="center" flex={1} padding="large">
          <Typography.Body weight="semiBold">
            {isError ? "Couldn't load this location" : 'Location not found'}
          </Typography.Body>
          <Typography.Caption type="secondary">
            {isError ? 'Something went wrong.' : 'This location may have been removed.'}
          </Typography.Caption>
          {isError ? <Button label="Retry" variant="default" onPress={() => void refetch()} /> : null}
        </Column>
      </AppLayout>
    );
  }

  return (
    <FormScreen<EditLocationForm>
      schema={editLocationSchema}
      defaultValues={{ name: location.name, enable: location.enable }}
      isEdit
      title="Edit Location"
      submitLabel="Save"
      fallbackError="Could not update the location."
      onSubmit={async (values, { dirtyFields }) => {
        await updateLocation.mutateAsync({
          pathParam: { storeId, locationId },
          bodyParam: toUpdateLocationPayload(values, dirtyFields),
        });
      }}
      mapError={(err, setError) => {
        const error = err as { code?: string };
        if (error.code === 'location_name_exists') {
          setError('name', {
            type: 'server',
            message: 'A location with this name already exists.',
          });
          return true;
        }
        return false;
      }}
    >
      {({ control, isSubmitting, submitOnLast }) => (
        <>
          <Input<EditLocationForm>
            name="name"
            control={control}
            label="Location name"
            required
            autoFocus
            disabled={isSubmitting}
            returnKeyType="done"
            onSubmitEditing={submitOnLast}
          />

          <ToggleRow>
            <ToggleText>
              <Typography.Body weight="semiBold">Enabled</Typography.Body>
              <Typography.Caption color={theme.colorTextSecondary}>
                {enableLocked
                  ? `${location.is_primary ? 'Head Office' : 'The default location'} can't be disabled.`
                  : 'Turn off to stop operations at this location.'}
              </Typography.Caption>
            </ToggleText>
            <Switch<EditLocationForm>
              name="enable"
              control={control}
              disabled={isSubmitting || enableLocked}
            />
          </ToggleRow>
        </>
      )}
    </FormScreen>
  );
}

const ToggleRow = styled.View`
  flex-direction: row;
  align-items: center;
  gap: ${({ theme }) => theme.sizing.regular}px;
  padding: ${({ theme }) => theme.sizing.regular}px;
  border-radius: ${({ theme }) => theme.borderRadius.xLarge}px;
  border-width: ${({ theme }) => theme.borderWidth.thin}px;
  border-color: ${({ theme }) => theme.colorBorder};
`;

const ToggleText = styled(View)`
  flex: 1;
`;
