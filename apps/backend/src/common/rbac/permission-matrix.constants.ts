/**
 * RBAC permission matrix — single source of truth (barrel).
 *
 * The definitions were split out of this former 542-line god-file into focused
 * modules; this barrel re-exports them so existing importers are unchanged:
 * - `entity-catalogue.ts` — the ENTITIES catalogue + code lookups
 * - `crud-matrices.ts`    — CRUD action types, frozen presets, matrix-map types
 * - `special-actions.ts`  — beyond-CRUD special-action grants + critical set
 * - `role-matrices.ts`    — STORE_OWNER / SUPER_ADMIN / default-role matrices
 *
 * Design goals (unchanged):
 * - Strong compile-time typing: entity keys must be valid EntityCode
 * - Conservative defaults: no accidental broad grants
 * - Explicit special-action grants for owner/super-admin
 * - Immutable/shared presets are frozen to prevent accidental mutation
 *
 * Pair this matrix with the startup validator (`validateMatrixIntegrity()`).
 */

export * from './entity-catalogue.js';
export * from './crud-matrices.js';
export * from './special-actions.js';
export * from './role-matrices.js';
