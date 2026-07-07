import { useFormContext, useWatch } from 'react-hook-form';
import { useMobileTheme } from '@ayphen/mobile-theme';
import { Column, ConfigSelectItem, Input, SelectGeneric, Typography } from '@ayphen/mobile-ui-components';
import type { LocationResponse, RoleResponse } from '@ayphen/api-manager';
import type { InviteStaffForm } from '../types/schema';
import { LocationsSelect } from './LocationsSelect';

const SET_OPTS = {
  shouldDirty: true,
  shouldValidate: true,
  shouldTouch: true,
} as const;

// ── Fields (read/write RHF state via context) ────────────────────────────────

export interface InviteFieldsProps {
  customRoles: RoleResponse[];
  rolesLoading: boolean;
  rolesError: boolean;
  onRetryRoles: () => void;
  locations: LocationResponse[];
  locationsLoading: boolean;
  locationsError: boolean;
  onRetryLocations: () => void;
  isSubmitting: boolean;
  submitOnLast: () => void;
}

export function InviteFields({
  customRoles,
  rolesLoading,
  rolesError,
  onRetryRoles,
  locations,
  locationsLoading,
  locationsError,
  onRetryLocations,
  isSubmitting,
  submitOnLast,
}: InviteFieldsProps) {
  const { theme } = useMobileTheme();
  const {
    control,
    setValue,
    formState: { errors },
  } = useFormContext<InviteStaffForm>();
  const roleId = useWatch({ control, name: 'roleId' });
  const locationIds = useWatch({ control, name: 'locationIds' });

  return (
    <Column gap={theme.sizing.large}>
      {/* Contact — never gated on roles/locations loading */}
      <Column gap={theme.sizing.small}>
        <Typography.Subtitle weight="bold">
          Who are you inviting?
        </Typography.Subtitle>
        <Input<InviteStaffForm>
          name="contact"
          control={control}
          label="Phone number"
          placeholder="e.g. 9876543210"
          keyboardType="phone-pad"
          required
          disabled={isSubmitting}
          returnKeyType="done"
          onSubmitEditing={submitOnLast}
        />
      </Column>

      {/* Role — single-select dropdown */}
      <SelectGeneric<RoleResponse>
        label="Role"
        required
        options={customRoles}
        value={roleId}
        valueKey="id"
        keyExtractor={(role) => role.id}
        onChange={(role) => setValue('roleId', role?.id ?? '', SET_OPTS)}
        disabled={isSubmitting}
        loading={rolesLoading}
        noDataMessage={
          rolesError
            ? "Couldn't load roles. Check your connection and try again."
            : 'No custom roles yet. Create one under Staff & Roles → Roles first.'
        }
        isError={rolesError}
        onRetry={onRetryRoles}
        errorMessage={errors.roleId?.message}
        displayRenderer={(selected) => (
          <Typography.Body>
            {selected ? selected.name : 'Select role'}
          </Typography.Body>
        )}
        renderItem={(role, onSelect, isSelected) => (
          <ConfigSelectItem
            title={role.name}
            isSelected={isSelected}
            disabled={false}
            onPress={() => onSelect(role)}
          />
        )}
      />

      {/* Locations — multi-select dropdown */}
      <Column gap={theme.sizing.small}>
        <LocationsSelect
          locations={locations}
          loading={locationsLoading}
          error={locationsError}
          onRetry={onRetryLocations}
          selectedIds={locationIds ?? []}
          disabled={isSubmitting}
          errorMessage={errors.locationIds?.message}
          onChange={(ids) => setValue('locationIds', ids, SET_OPTS)}
        />
        <Typography.Caption type="secondary">
          The invitee will only have access to the locations you select.
        </Typography.Caption>
      </Column>
    </Column>
  );
}