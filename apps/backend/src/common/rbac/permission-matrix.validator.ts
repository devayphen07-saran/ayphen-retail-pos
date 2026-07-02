/**
 * Matrix integrity validation.
 *
 * Runs once at module load. Any violation should fail server startup so
 * permission bugs never ship silently.
 */
import {
  ENTITIES,
  ENTITY_CODES,
  ENTITY_BY_CODE,
  STORE_OWNER_CRUD,
  STORE_OWNER_SPECIAL,
  SUPER_ADMIN_CRUD,
  SUPER_ADMIN_SPECIAL,
  SPECIAL_ACTIONS,
  CRITICAL_SPECIAL_ACTIONS,
  DEFAULT_ROLE_CRUD,
  DEFAULT_ROLE_ABSENT,
  type EntityCode,
  type SpecialActionMap,
} from './permission-matrix.constants.js';

const SCREAMING_SNAKE = /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/;

function push(errors: string[], message: string): void {
  errors.push(message);
}

function asEntityCodeSet(): Set<EntityCode> {
  return new Set<EntityCode>(ENTITY_CODES);
}

function getAllDeclaredSpecialActions(): Set<string> {
  return new Set(
    Object.values(SPECIAL_ACTIONS).flatMap((actions) => actions ?? []),
  );
}

function checkNoDuplicateEntityCodes(errors: string[]): void {
  const seen = new Set<string>();

  for (const entity of ENTITIES) {
    if (seen.has(entity.code)) {
      push(errors, `ENTITIES contains duplicate code: ${entity.code}.`);
    }
    seen.add(entity.code);
  }
}

function checkEntityCatalogue(errors: string[]): void {
  for (const entity of ENTITIES) {
    if (!entity.code || entity.code.trim().length === 0) {
      push(errors, 'ENTITIES contains an empty entity code.');
    }
    if (!entity.label || entity.label.trim().length === 0) {
      push(errors, `ENTITIES[${entity.code}] has an empty label.`);
    }

    const byCode = ENTITY_BY_CODE[entity.code];
    if (!byCode) {
      push(errors, `ENTITY_BY_CODE is missing entity: ${entity.code}.`);
      continue;
    }

    if (byCode.code !== entity.code) {
      push(errors, `ENTITY_BY_CODE[${entity.code}] is mismatched.`);
    }
  }
}

function checkCrudCoverage(
  label: string,
  matrix: Record<
    EntityCode,
    { view: boolean; create: boolean; edit: boolean; delete: boolean }
  >,
  errors: string[],
): void {
  const entitySet = asEntityCodeSet();

  for (const code of ENTITY_CODES) {
    if (!(code in matrix)) {
      push(errors, `${label} is missing entity: ${code}.`);
      continue;
    }

    const value = matrix[code];
    if (typeof value.view !== 'boolean') {
      push(errors, `${label}[${code}].view must be boolean.`);
    }
    if (typeof value.create !== 'boolean') {
      push(errors, `${label}[${code}].create must be boolean.`);
    }
    if (typeof value.edit !== 'boolean') {
      push(errors, `${label}[${code}].edit must be boolean.`);
    }
    if (typeof value.delete !== 'boolean') {
      push(errors, `${label}[${code}].delete must be boolean.`);
    }
  }

  for (const code of Object.keys(matrix)) {
    if (!entitySet.has(code as EntityCode)) {
      push(errors, `${label} references unknown entity: ${code}.`);
    }
  }
}

function checkPartialCrudReferences(
  label: string,
  matrix: Partial<Record<EntityCode, unknown>>,
  errors: string[],
): void {
  const entitySet = asEntityCodeSet();

  for (const code of Object.keys(matrix)) {
    if (!entitySet.has(code as EntityCode)) {
      push(errors, `${label} references unknown entity: ${code}.`);
    }
  }
}

function checkSpecialDeclarations(errors: string[]): void {
  const entitySet = asEntityCodeSet();
  const seen = new Set<string>();

  for (const [entity, actions] of Object.entries(SPECIAL_ACTIONS)) {
    if (!entitySet.has(entity as EntityCode)) {
      push(errors, `SPECIAL_ACTIONS references unknown entity: ${entity}.`);
      continue;
    }

    const localSeen = new Set<string>();

    for (const action of actions ?? []) {
      if (!SCREAMING_SNAKE.test(action)) {
        push(
          errors,
          `SPECIAL_ACTIONS[${entity}] contains non-SCREAMING_SNAKE action: ${action}.`,
        );
      }

      if (localSeen.has(action)) {
        push(
          errors,
          `SPECIAL_ACTIONS[${entity}] contains duplicate action: ${action}.`,
        );
      }
      localSeen.add(action);

      seen.add(`${entity}:${action}`);
    }
  }
}

function checkSpecialSubset(
  label: string,
  map: SpecialActionMap,
  errors: string[],
): void {
  const entitySet = asEntityCodeSet();

  for (const [entity, actions] of Object.entries(map)) {
    if (!entitySet.has(entity as EntityCode)) {
      push(errors, `${label} references unknown entity: ${entity}.`);
      continue;
    }

    const declared = SPECIAL_ACTIONS[entity as EntityCode];
    if (!declared) {
      push(
        errors,
        `${label}[${entity}] references entity with no declared special actions.`,
      );
      continue;
    }

    const declaredSet = new Set(declared);
    const localSeen = new Set<string>();

    for (const action of actions ?? []) {
      if (!declaredSet.has(action)) {
        push(
          errors,
          `${label}[${entity}] references undeclared action: ${action}.`,
        );
      }
      if (localSeen.has(action)) {
        push(
          errors,
          `${label}[${entity}] contains duplicate action: ${action}.`,
        );
      }
      localSeen.add(action);
    }
  }
}

function checkCriticalSpecialActions(errors: string[]): void {
  const declared = getAllDeclaredSpecialActions();

  for (const action of CRITICAL_SPECIAL_ACTIONS) {
    if (!declared.has(action)) {
      push(
        errors,
        `CRITICAL_SPECIAL_ACTIONS references undeclared action: ${action}.`,
      );
    }
  }
}

function checkDefaultRoleAbsent(errors: string[]): void {
  const entitySet = asEntityCodeSet();
  const explicitDefaultCrud = new Set<EntityCode>(
    Object.keys(DEFAULT_ROLE_CRUD) as EntityCode[],
  );
  const absentSet = new Set<EntityCode>();

  for (const code of DEFAULT_ROLE_ABSENT) {
    if (!entitySet.has(code)) {
      push(errors, `DEFAULT_ROLE_ABSENT references unknown entity: ${code}.`);
    }
    if (explicitDefaultCrud.has(code)) {
      push(
        errors,
        `DEFAULT_ROLE_ABSENT contains entity already present in DEFAULT_ROLE_CRUD: ${code}.`,
      );
    }
    if (absentSet.has(code)) {
      push(errors, `DEFAULT_ROLE_ABSENT contains duplicate entity: ${code}.`);
    }
    absentSet.add(code);
  }

  for (const code of ENTITY_CODES) {
    const inCrud = explicitDefaultCrud.has(code);
    const inAbsent = absentSet.has(code);

    if (!inCrud && !inAbsent) {
      push(
        errors,
        `Entity ${code} is in neither DEFAULT_ROLE_CRUD nor DEFAULT_ROLE_ABSENT.`,
      );
    }

    if (inCrud && inAbsent) {
      push(
        errors,
        `Entity ${code} is present in both DEFAULT_ROLE_CRUD and DEFAULT_ROLE_ABSENT.`,
      );
    }
  }
}

function checkOfflineMetadata(errors: string[]): void {
  for (const entity of ENTITY_CODES) {
    const meta = ENTITY_BY_CODE[entity];
    if (typeof meta.isOfflineSafe !== 'boolean') {
      push(errors, `ENTITY_BY_CODE[${entity}].isOfflineSafe must be boolean.`);
    }
    if (typeof meta.supportsAttachments !== 'boolean') {
      push(
        errors,
        `ENTITY_BY_CODE[${entity}].supportsAttachments must be boolean.`,
      );
    }
  }
}

export function validateMatrixIntegrity(): void {
  const errors: string[] = [];

  checkNoDuplicateEntityCodes(errors);
  checkEntityCatalogue(errors);
  checkOfflineMetadata(errors);

  checkCrudCoverage('STORE_OWNER_CRUD', STORE_OWNER_CRUD, errors);
  checkCrudCoverage('SUPER_ADMIN_CRUD', SUPER_ADMIN_CRUD, errors);

  checkPartialCrudReferences('DEFAULT_ROLE_CRUD', DEFAULT_ROLE_CRUD, errors);

  checkSpecialDeclarations(errors);
  checkSpecialSubset('STORE_OWNER_SPECIAL', STORE_OWNER_SPECIAL, errors);
  checkSpecialSubset('SUPER_ADMIN_SPECIAL', SUPER_ADMIN_SPECIAL, errors);
  checkCriticalSpecialActions(errors);

  checkDefaultRoleAbsent(errors);

  if (errors.length > 0) {
    throw new Error(
      `[RBAC] Permission matrix integrity check failed:\n- ${errors.join('\n- ')}`,
    );
  }
}
