import { useState } from 'react';
import { router } from 'expo-router';
import { useFormContext, useWatch } from 'react-hook-form';
import styled from 'styled-components/native';
import { useMobileTheme } from '@ayphen/mobile-theme';
import {
  Alert,
  CheckBox,
  Column,
  ConfigSelectItem,
  Input,
  LucideIcon,
  SelectGeneric,
  SheetConfirmActions,
  Typography,
  useBottomSheet,
} from '@ayphen/mobile-ui-components';
import {
  useCreateInvitationMutation,
  useLocationsQuery,
  useRolesQuery,
  type LocationResponse,
  type RoleResponse,
} from '@ayphen/api-manager';
import { useActiveStoreStore } from '@store';
import { FormScreen } from '../../../../components/FormScreen';
import {
  inviteStaffSchema,
  DEFAULT_INVITE_STAFF_VALUES,
  type InviteStaffForm,
} from '../types/schema';
import { toCreateInvitationPayload } from '../utils/transform';

const SET_OPTS = {
  shouldDirty: true,
  shouldValidate: true,
  shouldTouch: true,
} as const;

/**
 * Owner/manager side of the invitation flow: invite a person by phone to a
 * custom role scoped to one+ locations. Role and locations are dropdowns
 * (SelectGeneric + a bespoke multi-select sheet for locations, since
 * SelectGeneric itself is single-select-only). The contact field never waits
 * on roles/locations — each dropdown owns its own loading state instead of
 * the whole screen swapping to a full-page skeleton.
 */
export function InviteStaffScreen() {
  const storeId = useActiveStoreStore((s) => s.storeId) ?? '';
  const createInvitation = useCreateInvitationMutation();

  const {
    data: roles,
    isLoading: rolesLoading,
    isError: rolesError,
  } = useRolesQuery(storeId, { enabled: !!storeId });
  const {
    data: locations,
    isLoading: locationsLoading,
    isError: locationsError,
  } = useLocationsQuery(storeId, { enabled: !!storeId });

  // Only custom roles are invitable — system roles (Owner, etc.) are rejected
  // server-side, so don't offer them here.
  const customRoles = (roles ?? []).filter((r) => r.is_editable);

  return (
    <FormScreen<InviteStaffForm>
      schema={inviteStaffSchema}
      defaultValues={DEFAULT_INVITE_STAFF_VALUES}
      title="Invite Staff"
      submitLabel="Send invitation"
      loading={rolesLoading || locationsLoading}
      submitDisabled={rolesLoading || locationsLoading}
      fallbackError="Could not send the invitation."
      onSubmit={async (values) => {
        await createInvitation.mutateAsync({
          pathParam: { storeId },
          bodyParam: toCreateInvitationPayload(values),
        });
      }}
      onSuccess={() => {
        Alert.info(
          'Invitation sent',
          "They'll see it under their pending invitations the next time they open the app.",
        );
        router.back();
      }}
      mapError={(err, setError) => {
        const error = err as { code?: string };
        if (error.code === 'invitation_already_pending') {
          setError('contact', {
            type: 'server',
            message:
              'This person already has a pending invitation for that role.',
          });
          return true;
        }
        if (error.code === 'user_limit_reached') {
          Alert.info(
            'Staff limit reached',
            'Upgrade your plan to invite more team members.',
          );
          return true;
        }
        return false;
      }}
    >
      {({ isSubmitting, submitOnLast }) => (
        <InviteFields
          customRoles={customRoles}
          rolesLoading={rolesLoading}
          rolesError={rolesError}
          locations={locations ?? []}
          locationsLoading={locationsLoading}
          locationsError={locationsError}
          isSubmitting={isSubmitting}
          submitOnLast={submitOnLast}
        />
      )}
    </FormScreen>
  );
}

// ── Fields (read/write RHF state via context) ────────────────────────────────

interface InviteFieldsProps {
  customRoles: RoleResponse[];
  rolesLoading: boolean;
  rolesError: boolean;
  locations: LocationResponse[];
  locationsLoading: boolean;
  locationsError: boolean;
  isSubmitting: boolean;
  submitOnLast: () => void;
}

function InviteFields({
  customRoles,
  rolesLoading,
  rolesError,
  locations,
  locationsLoading,
  locationsError,
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
            ? "Couldn't load roles. Check your connection and reopen."
            : 'No custom roles yet. Create one under Staff & Roles → Roles first.'
        }
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

// ── Locations multi-select (SelectGeneric itself is single-select-only) ─────

interface LocationsSelectProps {
  locations: LocationResponse[];
  loading: boolean;
  error: boolean;
  selectedIds: string[];
  disabled: boolean;
  errorMessage: string | undefined;
  onChange: (ids: string[]) => void;
}

function LocationsSelect({
  locations,
  loading,
  error,
  selectedIds,
  disabled,
  errorMessage,
  onChange,
}: LocationsSelectProps) {
  const { theme } = useMobileTheme();
  const sheet = useBottomSheet();

  const openSheet = () => {
    sheet.open<LocationSelectSheetProps>({
      snapPoint: 'md',
      title: 'Select locations',
      closeOnBackdrop: true,
      Component: LocationSelectSheet,
      props: {
        locations,
        initialSelected: selectedIds,
        onConfirm: onChange,
      },
    });
  };

  const summary =
    selectedIds.length === 0
      ? 'Select locations'
      : selectedIds.length === 1
        ? (locations.find((l) => l.id === selectedIds[0])?.name ?? '1 selected')
        : `${selectedIds.length} locations selected`;

  return (
    <Column gap={4}>
      <Typography.Caption style={{ marginLeft: 3 }}>
        Locations
        <Typography.Body type="secondary" style={{ color: theme.colorRed }}>
          {' *'}
        </Typography.Body>
      </Typography.Caption>
      <SelectField
        activeOpacity={0.85}
        disabled={disabled || loading}
        style={{ opacity: disabled || loading ? 0.6 : 1 }}
        onPress={openSheet}
      >
        <Typography.Body>
          {loading
            ? 'Loading locations…'
            : error
              ? "Couldn't load locations"
              : summary}
        </Typography.Body>
        <LucideIcon
          name="ChevronDown"
          size={20}
          color={theme.colorTextSecondary}
        />
      </SelectField>
      {errorMessage && (
        <Typography.Caption color={theme.colorError} accessibilityRole="alert">
          {errorMessage}
        </Typography.Caption>
      )}
    </Column>
  );
}

interface LocationSelectSheetProps {
  locations: LocationResponse[];
  initialSelected: string[];
  onConfirm: (ids: string[]) => void;
}

/** Sheet content — a component reference, never a rendered element (modal-architecture-agent.md §9). */
function LocationSelectSheet({
  locations,
  initialSelected,
  onConfirm,
}: LocationSelectSheetProps) {
  const { theme } = useMobileTheme();
  const sheet = useBottomSheet();
  const [selected, setSelected] = useState<string[]>(initialSelected);

  const toggle = (id: string) =>
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );

  if (locations.length === 0) {
    return (
      <Column
        gap={theme.sizing.medium}
        style={{ padding: theme.sizing.medium }}
      >
        <Typography.Caption type="secondary">
          No locations available.
        </Typography.Caption>
        <SheetConfirmActions
          confirmLabel="Close"
          onConfirm={() => sheet.close()}
          onCancel={() => sheet.close()}
        />
      </Column>
    );
  }

  return (
    <Column gap={theme.sizing.small} style={{ padding: theme.sizing.medium }}>
      {locations.map((loc) => {
        const isSelected = selected.includes(loc.id);
        return (
          <LocationRow
            key={loc.id}
            activeOpacity={0.7}
            $selected={isSelected}
            onPress={() => toggle(loc.id)}
          >
            <Column flex={1} gap={2}>
              <Typography.Body weight="medium">{loc.name}</Typography.Body>
              {/* Every store's primary location is conventionally named
                  "Head Office" already — a badge here would just repeat the
                  name, so it's only shown for a differently-named primary. */}
              {loc.is_primary && loc.name !== 'Head Office' && (
                <Typography.Caption type="secondary">Head Office</Typography.Caption>
              )}
            </Column>
            <CheckBox value={isSelected} onValueChange={() => toggle(loc.id)} size={16} />
          </LocationRow>
        );
      })}
      <SheetConfirmActions
        confirmLabel="Done"
        cancelLabel="Cancel"
        onConfirm={() => {
          onConfirm(selected);
          sheet.close();
        }}
        onCancel={() => sheet.close()}
      />
    </Column>
  );
}

const LocationRow = styled.TouchableOpacity<{ $selected: boolean }>`
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  gap: ${({ theme }) => theme.sizing.small}px;
  background-color: ${({ theme, $selected }) =>
    $selected ? theme.color.primary.bg : theme.colorBgContainer};
  border-radius: ${({ theme }) => theme.borderRadius.large}px;
  border-width: ${({ theme, $selected }) =>
    $selected ? theme.borderWidth.light : theme.borderWidth.thin}px;
  border-color: ${({ theme, $selected }) =>
    $selected ? theme.color.primary.main : theme.colorBorder};
  padding: ${({ theme }) => theme.sizing.medium}px;
`;

const SelectField = styled.TouchableOpacity`
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  background-color: ${({ theme }) => theme.colorBgContainer};
  border-radius: ${({ theme }) => theme.borderRadius.large}px;
  border-width: ${({ theme }) => theme.borderWidth.thin}px;
  border-color: ${({ theme }) => theme.colorBorder};
  padding: ${({ theme }) => theme.sizing.medium}px;
`;
