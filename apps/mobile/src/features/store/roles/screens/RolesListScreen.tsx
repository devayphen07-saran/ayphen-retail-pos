import { useCallback } from 'react';
import { router } from 'expo-router';
import { AppLayout, IconButton, ListScaffold } from '@ayphen/mobile-ui-components';
import { useRolesQuery, type RoleResponse } from '@ayphen/api-manager';
import { useActiveStoreStore } from '@store';
import { usePermission } from '@core/auth/usePermission';
import { RolesListLoadingCard } from '../loading/RolesListLoading';
import { RoleCard } from '../components/RoleCard';

/** Custom roles + permission matrix — reached from More > Staff & Roles > Roles
 *  (rbac.md §21). System roles (e.g. this store's Owner) show up here too since
 *  the backend's list is store-scoped, not editable-only — flagged with a
 *  "System" tag and routed to a read-only view of their matrix. */
export function RolesListScreen() {
  const storeId = useActiveStoreStore((s) => s.storeId) ?? '';
  const { data: roles, isLoading, isError, isFetching, isRefetching, refetch } = useRolesQuery(
    storeId,
    { enabled: !!storeId },
  );
  // Local UX gating only — the create endpoint is still enforced server-side
  // regardless of this check (see usePermission.ts / permission-check.ts).
  const canCreateRole = usePermission('Role', 'create');

  const renderRole = useCallback(
    ({ item: role }: { item: RoleResponse }) => <RoleCard role={role} />,
    [],
  );

  return (
    <AppLayout
      title="Roles"
      onBack={() => router.back()}
      rightElement={
        canCreateRole ? (
          <IconButton
            iconName="Plus"
            variant="default"
            accessibilityLabel="Create role"
            onPress={() => router.push('/(store)/role-create')}
          />
        ) : undefined
      }
    >
      <ListScaffold<RoleResponse>
        data={roles ?? []}
        keyExtractor={(r) => r.id}
        renderItem={renderRole}
        estimatedItemSize={76}
        loaderProps={{
          isLoading,
          isFetching,
          isRefetching,
          loadingCard: () => <RolesListLoadingCard />,
          loaderLength: 4,
        }}
        listProps={{
          error: isError ? { message: "Couldn't load roles." } : undefined,
          refetch,
          addNew: canCreateRole ? () => router.push('/(store)/role-create') : undefined,
        }}
        emptyState={{
          message: 'No custom roles yet',
          description: 'Create a role to tailor what your staff can do.',
          icon: 'ShieldCheck',
        }}
      />
    </AppLayout>
  );
}