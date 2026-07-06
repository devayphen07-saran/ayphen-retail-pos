import { useRef } from 'react';
import { router } from 'expo-router';
import { Input, TextArea } from '@ayphen/mobile-ui-components';
import { useCreateRoleMutation } from '@ayphen/api-manager';
import { useActiveStoreStore } from '@store';
import { FormScreen } from '../../../../components/FormScreen';
import {
  createRoleSchema,
  DEFAULT_CREATE_ROLE_VALUES,
  type CreateRoleForm,
} from '../types/schema';
import { toCreateRolePayload } from '../utils/transform';

/**
 * Create a custom role — matches CreateRoleDtoSchema (name + description). The
 * new role is seeded server-side with the DEFAULT_ROLE_CRUD baseline, so it's
 * immediately usable; on success we go straight into the permission matrix,
 * where an owner tailors it (a role with only default grants is rarely enough).
 */
export function CreateRoleScreen() {
  const storeId = useActiveStoreStore((s) => s.storeId) ?? '';
  const createRole = useCreateRoleMutation(storeId);
  // Captured in onSubmit, read in onSuccess (FormScreen resets before navigating).
  const created = useRef<{ id: string; name: string } | null>(null);

  return (
    <FormScreen<CreateRoleForm>
      schema={createRoleSchema}
      defaultValues={DEFAULT_CREATE_ROLE_VALUES}
      title="New Role"
      submitLabel="Create"
      fallbackError="Could not create the role."
      onSubmit={async (values) => {
        const role = await createRole.mutateAsync({
          pathParam: { storeId },
          bodyParam: toCreateRolePayload(values),
        });
        created.current = { id: role.id, name: role.name };
      }}
      onSuccess={() => {
        const role = created.current;
        if (!role) return;
        router.replace({
          pathname: '/(store)/role-permissions',
          params: { roleId: role.id, roleName: role.name, isEditable: 'true' },
        });
      }}
      mapError={(err, setError) => {
        const error = err as { code?: string };
        if (error.code === 'role_already_exists') {
          setError('name', {
            type: 'server',
            message: 'A role with this name already exists.',
          });
          return true;
        }
        return false;
      }}
    >
      {({ control, form, isSubmitting }) => (
        <>
          <Input<CreateRoleForm>
            name="name"
            control={control}
            label="Role name"
            placeholder="e.g. Shift Lead"
            required
            autoFocus
            disabled={isSubmitting}
            returnKeyType="next"
            onSubmitEditing={() => form.setFocus('description')}
          />
          <TextArea<CreateRoleForm>
            name="description"
            control={control}
            label="Description (optional)"
            placeholder="What this role is for"
            disabled={isSubmitting}
          />
        </>
      )}
    </FormScreen>
  );
}
