/**
 * EffectivePermissions — resolved CRUD + special grants for one (userId, storeId).
 *
 * Built from the union of all active role grants for that store, then cached in Redis.
 * This file also owns safe JSON serialization / deserialization for cache transport.
 */
import { isEntityCode } from './permission-matrix.constants.js';
import type { CrudAction, EntityCode } from './permission-matrix.constants.js';

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
 * Defensive clone so callers never share mutable nested objects by reference.
 */
export function clonePermissions(
  input: EffectivePermissions,
): EffectivePermissions {
  const crud = new Map<EntityCode, CrudPermissions>();
  for (const [entity, flags] of input.crud) {
    crud.set(entity, { ...flags });
  }

  const special = new Map<EntityCode, Set<string>>();
  for (const [entity, codes] of input.special) {
    special.set(entity, new Set(codes));
  }

  return { crud, special };
}

/**
 * Serialize to a stable JSON string for Redis.
 */
export function serializePermissions(
  permissions: EffectivePermissions,
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

  const payload: SerializedPermissions = { crud, special };
  return JSON.stringify(payload);
}

/**
 * Deserialize cached permissions.
 *
 * Throws on malformed JSON or unexpected shape.
 * Caller should treat a thrown error as cache corruption and rebuild from DB.
 */
export function deserializePermissions(raw: string): EffectivePermissions {
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
 * Union source permissions into target permissions.
 * Used while resolving grants from multiple roles.
 */
export function mergePermissions(
  target: EffectivePermissions,
  source: EffectivePermissions,
): EffectivePermissions {
  const merged = clonePermissions(target);

  for (const [entity, flags] of source.crud) {
    const current = merged.crud.get(entity);
    if (!current) {
      merged.crud.set(entity, { ...flags });
      continue;
    }

    merged.crud.set(entity, {
      view: current.view || flags.view,
      create: current.create || flags.create,
      edit: current.edit || flags.edit,
      delete: current.delete || flags.delete,
    });
  }

  for (const [entity, codes] of source.special) {
    const current = merged.special.get(entity) ?? new Set<string>();
    for (const code of codes) current.add(code);
    merged.special.set(entity, current);
  }

  return merged;
}

/**
 * Grant or overwrite CRUD for one entity.
 */
export function setCrud(
  permissions: EffectivePermissions,
  entity: EntityCode,
  crud: CrudPermissions,
): void {
  permissions.crud.set(entity, { ...crud });
}

/**
 * Add one special permission code for an entity.
 */
export function addSpecial(
  permissions: EffectivePermissions,
  entity: EntityCode,
  actionCode: string,
): void {
  const current = permissions.special.get(entity) ?? new Set<string>();
  current.add(actionCode);
  permissions.special.set(entity, current);
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
 * Optional utility for logs / debugging / tests.
 */
export function permissionsToObject(
  permissions: EffectivePermissions,
): SerializedPermissions {
  return JSON.parse(serializePermissions(permissions)) as SerializedPermissions;
}
