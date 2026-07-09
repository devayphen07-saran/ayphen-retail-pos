import { useFormContext, useWatch } from 'react-hook-form';
import { useMobileTheme } from '@ayphen/mobile-theme';
import { Column, ConfigSelectItem, Input, SelectGeneric, Typography } from '@ayphen/mobile-ui-components';
import type { RoleResponse } from '@ayphen/api-manager';
import type { InviteStaffForm } from '../types/schema';

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
  isSubmitting: boolean;
  submitOnLast: () => void;
}

export function InviteFields({
  customRoles,
  rolesLoading,
  rolesError,
  onRetryRoles,
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

  return (
    <Column gap={theme.sizing.large}>
      {/* Contact — never gated on roles loading */}
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
    </Column>
  );
}