import { APIData, APIMethod } from '../api-handler';

/**
 * Two-phase file/image upload (backend `apps/backend/src/files`). Every route is
 * store-scoped (`:storeId`) and auth-required — committed files are scoped to the
 * store, staged temps to the calling user. The flow: stage each file → save the
 * parent record → commit the staged guuids → list/render via presigned URLs.
 */

/** Phase 1 — stage one file. Multipart: `file` binary + `entity_type` + `kind` text fields. */
export const STAGE_FILE = new APIData('stores/:storeId/files/temp', APIMethod.POST);

/** Cancel a staged upload before commit. Path: `:storeId`, `:guuid`. */
export const CANCEL_STAGED = new APIData('stores/:storeId/files/temp/:guuid', APIMethod.DELETE);

/** Phase 2 — promote staged temps into permanent, record-linked files. */
export const COMMIT_FILES = new APIData('stores/:storeId/files/commit', APIMethod.POST);

/** List active files attached to a record. Query: `entity_type`, `record_guuid`. */
export const LIST_FILES = new APIData('stores/:storeId/files', APIMethod.GET);

/**
 * Batched grid read (P1-10): files for many records at once. Query: `entity_type`,
 * `record_guuids` (comma-separated, capped at 100). Returns a
 * `{ [record_guuid]: FileResponse[] }` map — one request per grid render.
 */
export const LIST_FILES_BATCH = new APIData('stores/:storeId/files/by-records', APIMethod.GET);

/** A single file with a fresh presigned URL. Path: `:storeId`, `:guuid`. */
export const GET_FILE = new APIData('stores/:storeId/files/:guuid', APIMethod.GET);

/** Soft-delete a file (moves to trash; recoverable). Path: `:storeId`, `:guuid`. */
export const DELETE_FILE = new APIData('stores/:storeId/files/:guuid', APIMethod.DELETE);

/** Restore a soft-deleted file. Path: `:storeId`, `:guuid`. */
export const RESTORE_FILE = new APIData('stores/:storeId/files/:guuid/restore', APIMethod.POST);
