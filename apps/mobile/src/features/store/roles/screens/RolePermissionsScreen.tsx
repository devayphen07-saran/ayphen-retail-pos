import { useEffect, useState } from 'react';
import { ScrollView } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import styled from 'styled-components/native';
import { useMobileTheme } from '@ayphen/mobile-theme';
import {
  Alert,
  AppLayout,
  Button,
  CheckBox,
  Column,
  Row,
  ScreenStateRenderer,
  Typography,
} from '@ayphen/mobile-ui-components';
import {
  useEntityTypesQuery,
  useRoleQuery,
  useUpdateRolePermissionsMutation,
} from '@ayphen/api-manager';
import type { CrudAction, RoleEntityPermissions } from '@ayphen/api-manager';
import { useActiveStoreStore } from '@store';
import { RolePermissionsLoading } from '../loading/RolePermissionsLoading';

type Params = { roleId: string; roleName: string; isEditable: string };

const ACTIONS: Array<{ key: CrudAction; label: string }> = [
  { key: 'view',   label: 'View' },
  { key: 'create', label: 'Create' },
  { key: 'edit',   label: 'Edit' },
  { key: 'delete', label: 'Delete' },
];

const EMPTY: RoleEntityPermissions = { view: false, create: false, edit: false, delete: false };

/**
 * Dependent-permission propagation, matching the React portal reference
 * (ApplicationPermissionList.tsx): each action implies every action to its
 * left, so the matrix can never represent e.g. "can delete but not view."
 * Levels: view < create < edit < delete.
 */
const LEVEL: Record<CrudAction, number> = { view: 0, create: 1, edit: 2, delete: 3 };

function applyToggle(current: RoleEntityPermissions, action: CrudAction, next: boolean): RoleEntityPermissions {
  const result = { ...current, [action]: next };
  const level = LEVEL[action];
  for (const { key } of ACTIONS) {
    if (next && LEVEL[key] < level) result[key] = true;   // checking an action implies everything below it
    if (!next && LEVEL[key] > level) result[key] = false; // unchecking clears everything above it
  }
  return result;
}

/**
 * Entity × action permission matrix for a role (rbac.md §21). Read-only for
 * system roles (isEditable=false — e.g. this store's Owner). Full-replace
 * semantics on save, matching PATCH :roleId/permissions exactly.
 */
export function RolePermissionsScreen() {
  const { theme } = useMobileTheme();
  const { roleId, roleName, isEditable } = useLocalSearchParams<Params>();
  const readOnly = isEditable !== 'true';
  const storeId = useActiveStoreStore((s) => s.storeId) ?? '';

  const {
    data: entityTypes,
    isLoading: entitiesLoading,
    isError: entitiesError,
    refetch: refetchEntities,
  } = useEntityTypesQuery();
  const {
    data: role,
    isLoading: roleLoading,
    isError: roleError,
    refetch: refetchRole,
  } = useRoleQuery(storeId, roleId, {
    enabled: !!storeId && !!roleId,
  });
  const updatePermissions = useUpdateRolePermissionsMutation(storeId);

  const [matrix, setMatrix] = useState<Record<string, RoleEntityPermissions>>({});
  const [saving, setSaving] = useState(false);

  // Seed local edit state once from the server response — a ref-guarded effect
  // would over-engineer this; `role` only changes on mount and after our own
  // save (which sets fresh matching state anyway), so a plain effect is fine.
  useEffect(() => {
    if (role) setMatrix(role.permissions);
  }, [role]);

  const toggle = (entityCode: string, action: CrudAction, next: boolean) => {
    if (readOnly) return;
    setMatrix((prev) => ({
      ...prev,
      [entityCode]: applyToggle(prev[entityCode] ?? EMPTY, action, next),
    }));
  };

  const toggleFullAccess = (entityCode: string, next: boolean) => {
    if (readOnly) return;
    setMatrix((prev) => ({
      ...prev,
      [entityCode]: { view: next, create: next, edit: next, delete: next },
    }));
  };

  const onSave = async () => {
    const permissions = Object.entries(matrix).flatMap(([entity, perms]) =>
      ACTIONS.filter(({ key }) => perms[key]).map(({ key }) => ({ entity, action: key })),
    );
    setSaving(true);
    try {
      await updatePermissions.mutateAsync({
        pathParam: { storeId, roleId },
        bodyParam: { permissions },
      });
      router.back();
    } catch {
      Alert.info('Error', "Couldn't save the permission changes.");
    } finally {
      setSaving(false);
    }
  };

  // Either query failing means the matrix can't be shown correctly (entityTypes
  // = the columns, role = the seeded values), so treat them together.
  const isLoading = entitiesLoading || roleLoading;
  const isError = entitiesError || roleError;
  const retry = () => {
    void refetchEntities();
    void refetchRole();
  };

  return (
    <AppLayout title={roleName || 'Role'} onBack={() => router.back()}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: theme.sizing.large, flexGrow: 1, paddingBottom: 100 }}
        showsVerticalScrollIndicator={false}
      >
        <ScreenStateRenderer
          isLoading={isLoading}
          isError={isError}
          data={entityTypes}
          skeleton={<RolePermissionsLoading />}
          error="Couldn't load the permission matrix."
          onRetry={retry}
        >
          {() => (
          <Column gap={8}>
            {readOnly && (
              <Typography.Caption type="secondary">
                This is a system role and can't be edited.
              </Typography.Caption>
            )}
            {entityTypes?.map((entity) => {
              const perms = matrix[entity.code] ?? EMPTY;
              const fullAccess = perms.view && perms.create && perms.edit && perms.delete;
              return (
                <EntityCard key={entity.code}>
                  <Row align="center" justify="space-between">
                    <Typography.Body weight="medium">{entity.label}</Typography.Body>
                    <CheckBox
                      value={fullAccess}
                      onValueChange={(next) => toggleFullAccess(entity.code, next)}
                      disabled={readOnly}
                      label="Full access"
                      labelPosition="right"
                      size={16}
                    />
                  </Row>
                  <Row gap={16}>
                    {ACTIONS.map(({ key, label }) => (
                      <CheckBox
                        key={key}
                        value={perms[key]}
                        onValueChange={(next) => toggle(entity.code, key, next)}
                        disabled={readOnly}
                        label={label}
                        labelPosition="right"
                        size={16}
                      />
                    ))}
                  </Row>
                </EntityCard>
              );
            })}
          </Column>
          )}
        </ScreenStateRenderer>
      </ScrollView>
      {!readOnly && !isLoading && !isError && !!entityTypes && (
        <FooterBar>
          <Button label="Save" variant="primary" loading={saving} onPress={onSave} />
        </FooterBar>
      )}
    </AppLayout>
  );
}

const EntityCard = styled.View`
  gap: ${({ theme }) => theme.sizing.small}px;
  padding: ${({ theme }) => theme.sizing.medium}px;
  border-radius: ${({ theme }) => theme.borderRadius.large}px;
  border-width: ${({ theme }) => theme.borderWidth.thin}px;
  border-color: ${({ theme }) => theme.colorBorder};
`;

const FooterBar = styled.View`
  padding: ${({ theme }) => theme.sizing.large}px;
  padding-bottom: ${({ theme }) => theme.sizing.xxLarge}px;
  background-color: ${({ theme }) => theme.colorBgContainer};
  border-top-width: ${({ theme }) => theme.borderWidth.thin}px;
  border-top-color: ${({ theme }) => theme.colorBorderSecondary};
`;
