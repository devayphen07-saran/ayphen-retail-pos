import { router } from 'expo-router';
import { Alert } from '@ayphen/mobile-ui-components';
import { useCreateInvitationMutation, useLocationsQuery, useRolesQuery } from '@ayphen/api-manager';
import { useActiveStoreStore } from '@store';
import { FormScreen } from '../../../../components/FormScreen';
import {
  inviteStaffSchema,
  DEFAULT_INVITE_STAFF_VALUES,
  type InviteStaffForm,
} from '../types/schema';
import { toCreateInvitationPayload } from '../utils/transform';
import { InviteFields } from '../components/InviteFields';

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
          onRetryRoles={() => void refetchRoles()}
          locations={locations ?? []}
          locationsLoading={locationsLoading}
          locationsError={locationsError}
          onRetryLocations={() => void refetchLocations()}
          isSubmitting={isSubmitting}
          submitOnLast={submitOnLast}
        />
      )}
    </FormScreen>
  );
}
