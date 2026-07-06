import { RefreshControl, ScrollView, View } from 'react-native';
import { router } from 'expo-router';
import styled from 'styled-components/native';
import { useMobileTheme } from '@ayphen/mobile-theme';
import {
  AppLayout,
  Column,
  IconButton,
  LucideIcon,
  Row,
  ScreenStateRenderer,
  Tag,
  Typography,
} from '@ayphen/mobile-ui-components';
import { useRolesQuery } from '@ayphen/api-manager';
import { useActiveStoreStore } from '@store';
import { usePermission } from '@core/auth/usePermission';
import { RolesListLoading } from '../loading/RolesListLoading';

/** Custom roles + permission matrix — reached from More > Staff & Roles > Roles
 *  (rbac.md §21). System roles (e.g. this store's Owner) show up here too since
 *  the backend's list is store-scoped, not editable-only — flagged with a
 *  "System" tag and routed to a read-only view of their matrix. */
export function RolesListScreen() {
  const { theme } = useMobileTheme();
  const storeId = useActiveStoreStore((s) => s.storeId) ?? '';
  const { data: roles, isLoading, isError, refetch, isRefetching } = useRolesQuery(storeId, {
    enabled: !!storeId,
  });
  // Local UX gating only — the create endpoint is still enforced server-side
  // regardless of this check (see usePermission.ts / permission-check.ts).
  const canCreateRole = usePermission('Role', 'create');

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
      <ScrollView
        contentContainerStyle={{ padding: theme.sizing.large, flexGrow: 1 }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={isRefetching && !isLoading} onRefresh={refetch} />
        }
      >
        <ScreenStateRenderer
          isLoading={isLoading}
          isError={isError}
          data={roles}
          skeleton={<RolesListLoading />}
          error="Couldn't load roles."
          emptyTitle="No custom roles yet"
          emptyDescription="Create a role to tailor what your staff can do."
          emptyAction={
            canCreateRole
              ? { label: 'Create role', onPress: () => router.push('/(store)/role-create') }
              : undefined
          }
          onRetry={() => refetch()}
        >
          {() => (
          <Column gap={10}>
            {roles?.map((role) => (
              <RoleCard
                key={role.id}
                activeOpacity={0.7}
                onPress={() =>
                  router.push({
                    pathname: '/(store)/role-permissions',
                    params: { roleId: role.id },
                  })
                }
              >
                <Row align="center" gap={12}>
                  <IconSlot>
                    <LucideIcon name="ShieldCheck" size={20} color={theme.colorPrimary} />
                  </IconSlot>
                  <Column flex={1} gap={4}>
                    <Typography.Body weight="medium">{role.name}</Typography.Body>
                    <Row gap={6} align="center">
                      {role.description && (
                        <Typography.Caption type="secondary">{role.description}</Typography.Caption>
                      )}
                      {!role.is_editable && <Tag label="System" variant="default" size="sm" />}
                    </Row>
                  </Column>
                  <LucideIcon name="ChevronRight" size={16} color={theme.colorTextTertiary} />
                </Row>
              </RoleCard>
            ))}
          </Column>
          )}
        </ScreenStateRenderer>
      </ScrollView>
    </AppLayout>
  );
}

const RoleCard = styled.TouchableOpacity`
  background-color: ${({ theme }) => theme.colorBgContainer};
  border-radius: ${({ theme }) => theme.borderRadius.xLarge}px;
  border-width: ${({ theme }) => theme.borderWidth.thin}px;
  border-color: ${({ theme }) => theme.colorBorder};
  padding: ${({ theme }) => theme.sizing.medium}px;
`;

const IconSlot = styled(View)`
  width: 40px;
  height: 40px;
  border-radius: ${({ theme }) => theme.borderRadius.large}px;
  align-items: center;
  justify-content: center;
  background-color: ${({ theme }) => theme.color.primary.bg};
`;
