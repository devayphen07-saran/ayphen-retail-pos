import { useState } from 'react';
import { View } from 'react-native';
import styled from 'styled-components/native';
import { router } from 'expo-router';
import { useMobileTheme } from '@ayphen/mobile-theme';
import { Button, Column, Input, Row, Switch, Typography } from '@ayphen/mobile-ui-components';
import { useCreateLocationMutation } from '@ayphen/api-manager';
import type { NormalizedError } from '@ayphen/api-manager';
import { useActiveStoreStore } from '@store';
import { FormScreen } from '../../../../components/FormScreen';
import {
  createLocationSchema,
  DEFAULT_CREATE_LOCATION_VALUES,
  type CreateLocationForm,
} from '../types/schema';
import { toCreateLocationPayload } from '../utils/transform';

interface LimitDetails {
  limit:   number | null;
  current: number;
}

/**
 * Create a location — matches the backend's minimal contract exactly
 * (CreateLocationDtoSchema: name + is_default only). Reached from
 * LocationsScreen's "+" button. All form chrome (provider, keyboard, submit
 * gating, unsaved-close guard, error mapping) is owned by FormScreen.
 */
export function CreateLocationScreen() {
  const { theme } = useMobileTheme();
  const storeId = useActiveStoreStore((s) => s.storeId) ?? '';
  const createLocation = useCreateLocationMutation(storeId);
  const [limitError, setLimitError] = useState<LimitDetails | null>(null);

  return (
    <FormScreen<CreateLocationForm>
      schema={createLocationSchema}
      defaultValues={DEFAULT_CREATE_LOCATION_VALUES}
      title="New Location"
      submitLabel="Create"
      fallbackError="Could not create the location."
      onSubmit={async (values) => {
        setLimitError(null);
        await createLocation.mutateAsync({
          pathParam: { storeId },
          bodyParam: toCreateLocationPayload(values),
        });
      }}
      mapError={(err, setError) => {
        const error = err as NormalizedError;
        if (error.code === 'location_name_exists') {
          setError('name', {
            type: 'server',
            message: 'A location with this name already exists.',
          });
          return true;
        }
        if (error.code === 'location_limit_reached') {
          const details = (error.data as { details?: LimitDetails } | undefined)?.details;
          setLimitError(details ?? { limit: null, current: 0 });
          return true;
        }
        return false;
      }}
    >
      {({ control, isSubmitting, submitOnLast }) => (
        <>
          {limitError && (
            <LimitBanner>
              <Typography.Caption color={theme.colorWarningText}>
                {limitError.limit === null
                  ? "You've reached your plan's location limit."
                  : `You've reached your plan's location limit (${limitError.current}/${limitError.limit}).`}
                {' '}Upgrade to add more.
              </Typography.Caption>
              <Button
                label="View plans"
                variant="default"
                size="sm"
                onPress={() => router.push('/(store)/subscription-plans')}
              />
            </LimitBanner>
          )}

          <Input<CreateLocationForm>
            name="name"
            control={control}
            label="Location name"
            placeholder="e.g. Warehouse"
            required
            autoFocus
            disabled={isSubmitting}
            returnKeyType="done"
            onSubmitEditing={submitOnLast}
          />

          <ToggleRow>
            <ToggleText>
              <Typography.Body weight="semiBold">Make this the default location</Typography.Body>
              <Typography.Caption color={theme.colorTextSecondary}>
                Devices open into this location by default.
              </Typography.Caption>
            </ToggleText>
            <Switch<CreateLocationForm> name="isDefault" control={control} disabled={isSubmitting} />
          </ToggleRow>
        </>
      )}
    </FormScreen>
  );
}

const ToggleRow = styled(Row)`
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

const LimitBanner = styled(Column)`
  gap: ${({ theme }) => theme.sizing.small}px;
  padding: ${({ theme }) => theme.sizing.medium}px;
  border-radius: ${({ theme }) => theme.borderRadius.large}px;
  background-color: ${({ theme }) => theme.colorWarningBg};
  border-width: ${({ theme }) => theme.borderWidth.thin}px;
  border-color: ${({ theme }) => theme.colorWarningBorder};
`;
