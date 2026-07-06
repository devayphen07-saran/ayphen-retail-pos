import { View } from 'react-native';
import styled from 'styled-components/native';
import { useLocalSearchParams } from 'expo-router';
import { useMobileTheme } from '@ayphen/mobile-theme';
import { Input, Switch, Typography } from '@ayphen/mobile-ui-components';
import { useUpdateLocationMutation } from '@ayphen/api-manager';
import { useActiveStoreStore } from '@store';
import { FormScreen } from '../../../../components/FormScreen';
import { editLocationSchema, type EditLocationForm } from '../types/schema';
import { toUpdateLocationPayload } from '../utils/transform';

type Params = {
  locationId: string;
  name:       string;
  enable:     string; // 'true' | 'false' — expo-router params are always strings
  isPrimary:  string;
  isDefault:  string;
};

/**
 * Rename / enable-disable an existing location. Separate from
 * CreateLocationScreen because create's `is_default` toggle and edit's `enable`
 * toggle are different backend contracts (Create vs Update DTO) — a documented
 * §11A structural split. Both screens share FormScreen, so the form behavior is
 * identical. Prefilled from the row the user tapped (no GET-single endpoint).
 * Edit is `isEdit` → PATCHes only the changed keys and closes silently if nothing changed.
 */
export function EditLocationScreen() {
  const { theme } = useMobileTheme();
  const params = useLocalSearchParams<Params>();
  const storeId = useActiveStoreStore((s) => s.storeId) ?? '';
  const updateLocation = useUpdateLocationMutation(storeId);

  const isPrimary = params.isPrimary === 'true';
  const isDefault = params.isDefault === 'true';
  const enableLocked = isPrimary || isDefault;

  return (
    <FormScreen<EditLocationForm>
      schema={editLocationSchema}
      defaultValues={{ name: params.name ?? '', enable: params.enable === 'true' }}
      isEdit
      title="Edit Location"
      submitLabel="Save"
      fallbackError="Could not update the location."
      onSubmit={async (values, { dirtyFields }) => {
        await updateLocation.mutateAsync({
          pathParam: { storeId, locationId: params.locationId },
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
                  ? `${isPrimary ? 'Head Office' : 'The default location'} can't be disabled.`
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