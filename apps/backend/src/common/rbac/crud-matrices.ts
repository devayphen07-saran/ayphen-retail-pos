/**
 * CRUD action types, the frozen CRUD presets, and the matrix-map types.
 * Split out of the former `permission-matrix.constants.ts` god-file;
 * re-exported from that barrel for backward compatibility.
 */
import type { EntityCode } from './entity-catalogue.js';

// ── Action types ─────────────────────────────────────────────────────────────

export const CRUD_ACTIONS = ['view', 'create', 'edit', 'delete'] as const;
export type CrudAction = (typeof CRUD_ACTIONS)[number];

export interface CrudMatrix {
  view: boolean;
  create: boolean;
  edit: boolean;
  delete: boolean;
}

export function freezeCrud(matrix: CrudMatrix): Readonly<CrudMatrix> {
  return Object.freeze({ ...matrix });
}

// ── CRUD presets ─────────────────────────────────────────────────────────────

export const FULL = freezeCrud({
  view: true,
  create: true,
  edit: true,
  delete: true,
});

export const NO_DELETE = freezeCrud({
  view: true,
  create: true,
  edit: true,
  delete: false,
});

export const VIEW_EDIT = freezeCrud({
  view: true,
  create: false,
  edit: true,
  delete: false,
});

export const VIEW_CREATE = freezeCrud({
  view: true,
  create: true,
  edit: false,
  delete: false,
});

export const VIEW_ONLY = freezeCrud({
  view: true,
  create: false,
  edit: false,
  delete: false,
});

export const NONE = freezeCrud({
  view: false,
  create: false,
  edit: false,
  delete: false,
});

// ── Matrix-map types (keyed by EntityCode) ───────────────────────────────────

export type CrudMatrixMap = Record<EntityCode, Readonly<CrudMatrix>>;
export type PartialCrudMatrixMap = Partial<
  Record<EntityCode, Readonly<CrudMatrix>>
>;
export type SpecialActionMap = Partial<Record<EntityCode, readonly string[]>>;
