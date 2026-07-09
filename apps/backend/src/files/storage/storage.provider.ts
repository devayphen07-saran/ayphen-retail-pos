/**
 * Object-store port (hexagonal boundary). The Files feature depends only on
 * this interface; the concrete binding is chosen at module-wire time by
 * `StorageModule` — a real S3-compatible store when `STORAGE_BUCKET` is set,
 * otherwise the on-disk dev provider (same "absent → fake provider" pattern
 * the payments module uses for Razorpay).
 *
 * Keys are tenant-prefixed by the caller (`files.service`), never derived from
 * client input — see the storage-key convention in FilesService.
 */
export const STORAGE_PROVIDER = Symbol('STORAGE_PROVIDER');

export interface PutObjectResult {
  /** Canonical, non-presigned object URL (informational; never handed to clients). */
  url: string;
}

export interface StorageProvider {
  /** Write bytes at `key`. Private by default — reads only ever go through a signed GET URL. */
  putObject(key: string, body: Buffer, contentType: string): Promise<PutObjectResult>;

  /** Delete the object at `key`. Idempotent — a missing object is not an error. */
  deleteObject(key: string): Promise<void>;

  /** Copy `fromKey` → `toKey` (no delete). Commit copies staged → committed, then deletes the staged object only after the DB transaction succeeds (Part C swap-before-delete ordering). */
  copyObject(fromKey: string, toKey: string): Promise<void>;

  /** A short-lived presigned GET URL for private reads. Regenerated at read time — never stored. */
  getSignedUrl(key: string, expiresInSeconds: number): Promise<string>;

  /** Whether an object exists (reconciliation / orphan checks). */
  objectExists(key: string): Promise<boolean>;
}
