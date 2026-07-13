/**
 * EffectivePermissions — resolved CRUD + special grants for one (userId, storeId).
 *
 * Built from the union of all active role grants for that store, then cached in Redis.
 * This file also owns safe JSON serialization / deserialization for cache transport.
 */
import { isEntityCode } from './permission-matrix.constants.js';
import type { CrudAction, EntityCode } from './permission-matrix.constants.js';
import { ForbiddenError } from '#common/exceptions/app.exception.js';
import { ErrorCodes } from '#common/error-codes.js';
import type { RbacService } from './rbac.service.js';

/** Special action codes are SCREAMING_SNAKE_CASE (rbac.md §7). */
const SPECIAL_CODE_REGEX = /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/;

export interface CrudPermissions {
  view: boolean;
  create: boolean;
  edit: boolean;
  delete: boolean;
}

export interface EffectivePermissions {
  crud: Map<EntityCode, CrudPermissions>;
  special: Map<EntityCode, Set<string>>;
}

/**
 * JSON-safe form for Redis / snapshots.
 * Map and Set are not directly serializable.
 */
export interface SerializedPermissions {
  crud: Partial<Record<EntityCode, CrudPermissions>>;
  special: Partial<Record<EntityCode, string[]>>;
}

/** A cached permissions entry, tagged with the epoch-ms time it was resolved
 *  from the DB. Freshness is judged from this field — read atomically as part
 *  of the same GET as the payload — rather than from Redis key TTL, which
 *  requires a second round trip and can race a concurrent cache write. */
export interface CachedPermissionsEntry {
  permissions: EffectivePermissions;
  resolvedAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeCrudPermissions(
  value: unknown,
  entity: string,
): CrudPermissions {
  if (!isRecord(value)) {
    throw new Error(`Malformed CRUD permissions for entity "${entity}".`);
  }

  return {
    view: Boolean(value.view),
    create: Boolean(value.create),
    edit: Boolean(value.edit),
    delete: Boolean(value.delete),
  };
}

function normalizeSpecialCodes(value: unknown, entity: string): Set<string> {
  if (!Array.isArray(value)) {
    throw new Error(`Malformed special permissions for entity "${entity}".`);
  }

  const normalized = value.map((code) => {
    if (typeof code !== 'string' || !SPECIAL_CODE_REGEX.test(code)) {
      throw new Error(
        `Invalid special action code "${String(code)}" in entity "${entity}".`,
      );
    }
    return code;
  });

  return new Set(normalized);
}

export function emptyPermissions(): EffectivePermissions {
  return {
    crud: new Map<EntityCode, CrudPermissions>(),
    special: new Map<EntityCode, Set<string>>(),
  };
}

/**
 * Serialize to a stable JSON string for Redis, tagged with the epoch-ms time
 * it was resolved (see CachedPermissionsEntry — freshness is read from this
 * field, not from Redis key TTL).
 */
export function serializePermissions(
  permissions: EffectivePermissions,
  resolvedAt: number,
): string {
  const crud: Partial<Record<EntityCode, CrudPermissions>> = {};
  for (const [entity, flags] of permissions.crud) {
    crud[entity] = {
      view: flags.view,
      create: flags.create,
      edit: flags.edit,
      delete: flags.delete,
    };
  }

  const special: Partial<Record<EntityCode, string[]>> = {};
  for (const [entity, codes] of permissions.special) {
    special[entity] = [...codes].sort();
  }

  const payload: SerializedPermissions & { resolvedAt: number } = {
    crud,
    special,
    resolvedAt,
  };
  return JSON.stringify(payload);
}

function parsePermissionsBody(parsed: Record<string, unknown>): EffectivePermissions {
  const rawCrud = parsed.crud;
  const rawSpecial = parsed.special;

  if (!isRecord(rawCrud)) {
    throw new Error(
      'Malformed cached permissions payload: "crud" must be an object.',
    );
  }

  if (!isRecord(rawSpecial)) {
    throw new Error(
      'Malformed cached permissions payload: "special" must be an object.',
    );
  }

  const crud = new Map<EntityCode, CrudPermissions>();
  for (const [entity, flags] of Object.entries(rawCrud)) {
    if (!isEntityCode(entity)) {
      throw new Error(`Unknown entity code in cached permissions: "${entity}".`);
    }
    crud.set(entity, normalizeCrudPermissions(flags, entity));
  }

  const special = new Map<EntityCode, Set<string>>();
  for (const [entity, codes] of Object.entries(rawSpecial)) {
    if (!isEntityCode(entity)) {
      throw new Error(`Unknown entity code in cached permissions: "${entity}".`);
    }
    special.set(entity, normalizeSpecialCodes(codes, entity));
  }

  return { crud, special };
}

/**
 * Deserialize a cache entry written by serializePermissions, including its
 * resolvedAt freshness tag. Throws on malformed JSON, unexpected shape, or a
 * missing/non-numeric resolvedAt — the caller treats a throw as cache
 * corruption and rebuilds from DB.
 */
export function deserializeCachedEntry(raw: string): CachedPermissionsEntry {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Malformed cached permissions payload: invalid JSON.');
  }

  if (!isRecord(parsed)) {
    throw new Error(
      'Malformed cached permissions payload: root must be an object.',
    );
  }

  if (typeof parsed.resolvedAt !== 'number' || !Number.isFinite(parsed.resolvedAt)) {
    throw new Error(
      'Malformed cached permissions payload: "resolvedAt" must be a number.',
    );
  }

  return {
    permissions: parsePermissionsBody(parsed),
    resolvedAt: parsed.resolvedAt,
  };
}

/**
 * CRUD check — does the resolved matrix grant `action` on `entity`?
 */
export function checkCrud(
  permissions: EffectivePermissions,
  entity: EntityCode,
  action: CrudAction,
): boolean {
  return permissions.crud.get(entity)?.[action] ?? false;
}

/**
 * Special-action check — is `actionCode` granted on `entity`?
 */
export function checkSpecial(
  permissions: EffectivePermissions,
  entity: EntityCode,
  actionCode: string,
): boolean {
  return permissions.special.get(entity)?.has(actionCode) ?? false;
}

/**
 * Escalation guard (rbac.md) shared by RoleService.updatePermissions,
 * RoleAssignmentService.assignRole, and InvitationService.validateContactAndRole
 * — an actor must never grant, assign, or invite someone into a role broader
 * than their own live grants in this store (otherwise Role.edit +
 * UserRoleMapping.create/Invitation.create is enough to mint full CRUD for
 * every entity and self-assign it). `entityCodeOf` extracts the entity code
 * from each caller's own grant shape (they differ: `{entity}` vs
 * `{entityCode}`) so the thrown error's `details.grants` stays exactly the
 * caller's original shape instead of a normalized one.
 *
 * Critical read: `getCachedPermissions`'s `isCritical` flag must stay `true`
 * — this must reflect the actor's live grants, not a standard-request-stale
 * cache.
 */
export async function assertGrantsWithinActorScope<T extends { action: CrudAction }>(
  rbac: RbacService,
  actorId: string,
  storeId: string,
  grants: T[],
  entityCodeOf: (grant: T) => string,
  message: string,
): Promise<void> {
  const actorPermissions = await rbac.getCachedPermissions(actorId, storeId, true);
  const beyondActor = grants.filter((g) => {
    const code = entityCodeOf(g);
    return isEntityCode(code) && !checkCrud(actorPermissions, code, g.action);
  });
  if (beyondActor.length > 0) {
    throw new ForbiddenError(
      ErrorCodes.GRANT_EXCEEDS_ACTOR_PERMISSIONS,
      message,
      { grants: beyondActor },
    );
  }
}
