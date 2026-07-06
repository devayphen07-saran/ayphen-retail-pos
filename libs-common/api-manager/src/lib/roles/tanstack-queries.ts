import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  GET_ROLES,
  GET_ROLE,
  CREATE_ROLE,
  UPDATE_ROLE_PERMISSIONS,
  DELETE_ROLE,
  ASSIGN_ROLE,
  REVOKE_ROLE,
} from './api-data';
import type {
  RoleResponse,
  RoleDetailResponse,
  CreatedRoleResponse,
  CreateRoleRequest,
  UpdateRolePermissionsRequest,
} from './types';

export const roleKeys = {
  all:    ['roles'] as const,
  list:   (storeId: string) => [...roleKeys.all, storeId] as const,
  detail: (storeId: string, roleId: string) => [...roleKeys.all, storeId, roleId] as const,
};

/** Custom roles in a store. Callers pass `pathParam: { storeId }` on the mutations below. */
export const useRolesQuery = (storeId: string, options?: { enabled?: boolean }) =>
  useQuery({
    ...GET_ROLES.queryOptions<RoleResponse[]>({ pathParam: { storeId } }),
    queryKey: roleKeys.list(storeId),
    enabled: options?.enabled ?? !!storeId,
  });

/** A role's current permission matrix — the edit screen's prefill source. */
export const useRoleQuery = (storeId: string, roleId: string, options?: { enabled?: boolean }) =>
  useQuery({
    ...GET_ROLE.queryOptions<RoleDetailResponse>({ pathParam: { storeId, roleId } }),
    queryKey: roleKeys.detail(storeId, roleId),
    enabled: options?.enabled ?? (!!storeId && !!roleId),
  });

/** Create a role. Caller passes `{ pathParam: { storeId }, bodyParam }`. */
export const useCreateRoleMutation = (storeId: string) => {
  const queryClient = useQueryClient();
  return useMutation(
    CREATE_ROLE.mutationOptions<CreatedRoleResponse, CreateRoleRequest>({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: roleKeys.list(storeId) });
      },
    }),
  );
};

/** Full-replace a role's CRUD grants. Caller passes `{ pathParam: { storeId, roleId }, bodyParam }`. */
export const useUpdateRolePermissionsMutation = (storeId: string) => {
  const queryClient = useQueryClient();
  return useMutation(
    UPDATE_ROLE_PERMISSIONS.mutationOptions<void, UpdateRolePermissionsRequest>({
      onSuccess: (_data, variables) => {
        const roleId = variables.pathParam?.['roleId'] as string | undefined;
        if (roleId) queryClient.invalidateQueries({ queryKey: roleKeys.detail(storeId, roleId) });
        queryClient.invalidateQueries({ queryKey: roleKeys.list(storeId) });
      },
    }),
  );
};

/** Delete a role. Caller passes `{ pathParam: { storeId, roleId } }`. */
export const useDeleteRoleMutation = (storeId: string) => {
  const queryClient = useQueryClient();
  return useMutation(
    DELETE_ROLE.mutationOptions<void, undefined>({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: roleKeys.list(storeId) });
      },
    }),
  );
};

/** Assign an existing account member to a role. Caller passes
 *  `{ pathParam: { storeId, roleId }, bodyParam: { user_id } }`. */
export const useAssignRoleMutation = (storeId: string) => {
  const queryClient = useQueryClient();
  return useMutation(
    ASSIGN_ROLE.mutationOptions<void, { user_id: string }>({
      onSuccess: (_data, variables) => {
        const roleId = variables.pathParam?.['roleId'] as string | undefined;
        if (roleId) queryClient.invalidateQueries({ queryKey: roleKeys.detail(storeId, roleId) });
      },
    }),
  );
};

/** Revoke a user's role assignment. Caller passes `{ pathParam: { storeId, roleId, userId } }`. */
export const useRevokeRoleMutation = (storeId: string) => {
  const queryClient = useQueryClient();
  return useMutation(
    REVOKE_ROLE.mutationOptions<void, undefined>({
      onSuccess: (_data, variables) => {
        const roleId = variables.pathParam?.['roleId'] as string | undefined;
        if (roleId) queryClient.invalidateQueries({ queryKey: roleKeys.detail(storeId, roleId) });
      },
    }),
  );
};
