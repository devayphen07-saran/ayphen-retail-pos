import { useMemo } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import { useFormContext, useWatch } from 'react-hook-form';
import styled from 'styled-components/native';
import { useMobileTheme } from '@ayphen/mobile-theme';
import {
  Alert,
  CheckBox,
  Column,
  Input,
  LucideIcon,
  NoDataContainer,
  Row,
  SegmentedTabs,
  Tag,
  Typography,
} from '@ayphen/mobile-ui-components';
import {
  useCreateInvitationMutation,
  useLocationsQuery,
  useRolesQuery,
  type LocationResponse,
  type RoleResponse,
} from '@ayphen/api-manager';
import { InviteStaffLoading } from '../loading/InviteStaffLoading';
import { useActiveStoreStore } from '@store';
import { FormScreen } from '../../../../components/FormScreen';
import {
  inviteStaffSchema,
  DEFAULT_INVITE_STAFF_VALUES,
  type InviteStaffForm,
} from '../types/schema';
import { toCreateInvitationPayload } from '../utils/transform';

type ContactMethod = InviteStaffForm['method'];
const SET_OPTS = { shouldDirty: true, shouldValidate: true, shouldTouch: true } as const;

/**
 * Owner/manager side of the invitation flow: invite a person (by phone or email)
 * to a custom role scoped to one+ locations. Role and locations are now real
 * schema fields (§1) validated by Zod, not hand-checked in the submit handler.
 * Async loading (roles + locations) is rendered inside FormScreen's body.
 */
export function InviteStaffScreen() {
  const storeId = useActiveStoreStore((s) => s.storeId) ?? '';
  const createInvitation = useCreateInvitationMutation();

  const {
    data: roles,
    isLoading: rolesLoading,
    isError: rolesError,
    refetch: refetchRoles,
  } = useRolesQuery(storeId, { enabled: !!storeId });
  const {
    data: locations,
    isLoading: locationsLoading,
    isError: locationsError,
    refetch: refetchLocations,
  } = useLocationsQuery(storeId, { enabled: !!storeId });

  // Only custom roles are invitable — system roles (Owner, etc.) are rejected
  // server-side, so don't offer them here.
  const customRoles = useMemo(() => (roles ?? []).filter((r) => r.is_editable), [roles]);

  const loading = rolesLoading || locationsLoading;
  // Either query failing with nothing cached means the form can't be filled in;
  // show a retry rather than an empty list that reads as "you have none".
  const loadError = Boolean((rolesError && !roles) || (locationsError && !locations));

  return (
    <FormScreen<InviteStaffForm>
      schema={inviteStaffSchema}
      defaultValues={DEFAULT_INVITE_STAFF_VALUES}
      title="Invite Staff"
      submitLabel="Send invitation"
      loading={loading}
      submitDisabled={loading || loadError || customRoles.length === 0}
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
            message: 'This person already has a pending invitation for that role.',
          });
          return true;
        }
        if (error.code === 'user_limit_reached') {
          Alert.info('Staff limit reached', 'Upgrade your plan to invite more team members.');
          return true;
        }
        return false;
      }}
    >
      {({ isSubmitting, submitOnLast }) =>
        loading ? (
          <InviteStaffLoading />
        ) : loadError ? (
          <NoDataContainer
            iconName="TriangleAlert"
            message="Couldn't load the form"
            description="We couldn't load this store's roles and locations."
            buttonProps={{
              buttonText: 'Retry',
              onPress: () => {
                void refetchRoles();
                void refetchLocations();
              },
            }}
          />
        ) : (
          <InviteFields
            customRoles={customRoles}
            locations={locations ?? []}
            isSubmitting={isSubmitting}
            submitOnLast={submitOnLast}
          />
        )
      }
    </FormScreen>
  );
}

// ── Fields (read/write RHF state via context) ────────────────────────────────

interface InviteFieldsProps {
  customRoles:  RoleResponse[];
  locations:    LocationResponse[];
  isSubmitting: boolean;
  submitOnLast: () => void;
}

function InviteFields({ customRoles, locations, isSubmitting, submitOnLast }: InviteFieldsProps) {
  const { theme } = useMobileTheme();
  const { control, setValue, formState: { errors } } = useFormContext<InviteStaffForm>();
  const method = useWatch({ control, name: 'method' });
  const roleId = useWatch({ control, name: 'roleId' });
  const locationIds = useWatch({ control, name: 'locationIds' });

  const toggleLocation = (id: string, next: boolean) => {
    const current = new Set(locationIds ?? []);
    if (next) current.add(id);
    else current.delete(id);
    setValue('locationIds', [...current], SET_OPTS);
  };

  return (
    <Column gap={theme.sizing.large}>
      {/* Contact */}
      <Column gap={theme.sizing.small}>
        <Typography.Subtitle weight="bold">Who are you inviting?</Typography.Subtitle>
        <SegmentedTabs
          items={[
            { key: 'phone', label: 'Phone' },
            { key: 'email', label: 'Email' },
          ]}
          selectedKey={method}
          onChange={(key) => setValue('method', key as ContactMethod, SET_OPTS)}
        />
        <Input<InviteStaffForm>
          name="contact"
          control={control}
          label={method === 'phone' ? 'Phone number' : 'Email address'}
          placeholder={method === 'phone' ? 'e.g. 9876543210' : 'e.g. name@example.com'}
          keyboardType={method === 'phone' ? 'phone-pad' : 'email-address'}
          autoCapitalize="none"
          required
          disabled={isSubmitting}
          returnKeyType="done"
          onSubmitEditing={submitOnLast}
        />
      </Column>

      {/* Role */}
      <Column gap={theme.sizing.small}>
        <Typography.Subtitle weight="bold">Role</Typography.Subtitle>
        {customRoles.length === 0 ? (
          <EmptyNote>
            <Typography.Caption type="secondary">
              No custom roles yet. Create one under Staff &amp; Roles → Roles first.
            </Typography.Caption>
          </EmptyNote>
        ) : (
          customRoles.map((role) => {
            const selected = role.id === roleId;
            return (
              <SelectCard
                key={role.id}
                activeOpacity={0.7}
                $selected={selected}
                onPress={() => setValue('roleId', role.id, SET_OPTS)}
              >
                <Column flex={1} gap={2}>
                  <Typography.Body weight="medium">{role.name}</Typography.Body>
                  {role.description && (
                    <Typography.Caption type="secondary">{role.description}</Typography.Caption>
                  )}
                </Column>
                {selected && (
                  <LucideIcon name="Check" size={18} color={theme.color.primary.main} />
                )}
              </SelectCard>
            );
          })
        )}
        {errors.roleId && (
          <Typography.Caption color={theme.colorError} accessibilityRole="alert">
            {errors.roleId.message}
          </Typography.Caption>
        )}
      </Column>

      {/* Locations */}
      <Column gap={theme.sizing.small}>
        <Typography.Subtitle weight="bold">Locations</Typography.Subtitle>
        <Typography.Caption type="secondary">
          The invitee will only have access to the locations you select.
        </Typography.Caption>
        {locations.map((loc) => (
          <Row key={loc.id} align="center" justify="space-between">
            <Row align="center" gap={6} style={{ flex: 1 }}>
              <Typography.Body>{loc.name}</Typography.Body>
              {loc.is_primary && <Tag label="Head Office" variant="info" size="sm" />}
            </Row>
            <CheckBox
              value={(locationIds ?? []).includes(loc.id)}
              onValueChange={(next) => toggleLocation(loc.id, next)}
              size={16}
            />
          </Row>
        ))}
        {errors.locationIds && (
          <Typography.Caption color={theme.colorError} accessibilityRole="alert">
            {errors.locationIds.message}
          </Typography.Caption>
        )}
      </Column>
    </Column>
  );
}

const SelectCard = styled.TouchableOpacity<{ $selected: boolean }>`
  flex-direction: row;
  align-items: center;
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

const EmptyNote = styled(View)`
  background-color: ${({ theme }) => theme.colorBgContainer};
  border-radius: ${({ theme }) => theme.borderRadius.large}px;
  border-width: ${({ theme }) => theme.borderWidth.thin}px;
  border-color: ${({ theme }) => theme.colorBorder};
  padding: ${({ theme }) => theme.sizing.medium}px;
`;