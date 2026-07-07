import { useEffect, useRef, useState } from 'react';
import { ScrollView } from 'react-native';
import { router, useLocalSearchParams, useNavigation } from 'expo-router';
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
import { usePermission } from '@core/auth/usePermission';
import { RolePermissionsLoading } from '../loading/RolePermissionsLoading';

type Params = { roleId: string };

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
  const { roleId } = useLocalSearchParams<Params>();
  const storeId = useActiveStoreStore((s) => s.storeId) ?? '';
  const navigation = useNavigation();

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

  // Two independent reasons a matrix can be read-only: the role itself is a
  // system role (role.is_editable, read fresh — never trusted from params),
  // or the current user just lacks Role:edit — the second is local UX gating
  // only, still enforced for real server-side. Default to read-only while
  // `role` hasn't loaded yet (fail closed, not fail open).
  const canEditRoles = usePermission('Role', 'edit');
  const readOnly = !role?.is_editable || !canEditRoles;
  const updatePermissions = useUpdateRolePermissionsMutation(storeId);

  const [matrix, setMatrix] = useState<Record<string, RoleEntityPermissions>>({});
  const [saving, setSaving] = useState(false);

  // Seed local edit state exactly ONCE from the server response. A ref guard is
  // required (not over-engineering): once focusManager/onlineManager are wired,
  // a window-focus/reconnect refetch returns a fresh `role` object and an
  // unguarded effect would clobber the user's in-progress matrix edits.
  const seeded = useRef(false);
  useEffect(() => {
    if (role && !seeded.current) {
      seeded.current = true;
      setMatrix(role.permissions);
    }
  }, [role]);

  // An owner can spend real time building this matrix out — unlike FormScreen
  // (which every other edit screen in the app inherits this from), this
  // screen is hand-rolled, so it never got the same unsaved-changes guard on
  // back/swipe/hardware-back. Comparing against the server's last-seeded
  // values (not `seeded`/initial state) means the guard reflects only actual,
  // unsaved edits.
  const hasUnsavedChanges = !!role && JSON.stringify(matrix) !== JSON.stringify(role.permissions);
  const dirtyRef = useRef(hasUnsavedChanges);
  dirtyRef.current = hasUnsavedChanges;
  const bypassGuardRef = useRef(false);

  useEffect(() => {
    const sub = navigation.addListener('beforeRemove', (e) => {
      if (bypassGuardRef.current || !dirtyRef.current) return;
      e.preventDefault();
      Alert.show('Discard changes?', 'Your permission changes will be lost.', [
        { text: 'Keep editing', style: 'cancel' },
        {
          text: 'Discard',
          style: 'destructive',
          onPress: () => {
            bypassGuardRef.current = true;
            navigation.dispatch(e.data.action);
          },
        },
      ]);
    });
    return sub;
  }, [navigation]);

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
      // Success is not user intent to abandon the screen — bypass the
      // unsaved-changes guard above so this `router.back()` isn't intercepted.
      bypassGuardRef.current = true;
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
    <AppLayout title={role?.name ?? 'Role'} onBack={() => router.back()}>
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
                {!role?.is_editable
                  ? "This is a system role and can't be edited."
                  : "You don't have permission to edit roles."}
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
