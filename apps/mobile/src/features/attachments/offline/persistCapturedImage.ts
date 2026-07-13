import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import * as FileSystem from 'expo-file-system/legacy';
import * as Crypto from 'expo-crypto';
import { getSyncDb } from '@core/sync/db/client';
import { attachmentRepository } from '@core/sync/repositories/attachment.repository';
import { requestImageUpload } from '@core/sync/image-uploader-instance';
import type { PickedAsset } from '../hooks/useAttachmentPicker';

/** App-owned, persistent attachment storage — NOT the cache dir (the OS can purge cache). */
const ATTACHMENTS_DIR = `${FileSystem.documentDirectory}attachments/`;

export interface PersistCaptureParams {
  asset: PickedAsset;
  storeId: string;
  /** Polymorphic parent entity code — 'Product', 'Customer', 'Supplier', … */
  entityType: string;
  /** Parent record's client guuid — stable before the record ever reaches the server. */
  recordGuuid: string;
  /** File kind driving the files_config rule — defaults to 'image'. */
  kind?: string;
  userId: string;
}

/**
 * The offline capture pipeline (image-offline-architecture.md §C5 capture). All
 * local, zero network: downsize + compress the original, make a small thumbnail,
 * persist both to app-owned storage, hash for dedupe/idempotency, and insert the
 * local `attachment` row as `pending_upload`. The caller renders the thumb
 * immediately; the background uploader takes it from here when online.
 *
 * Returns the new attachment guuid.
 */
export async function persistCapturedImage(p: PersistCaptureParams): Promise<string> {
  // Downsize the original to ~1200px (a POS thumbnail never needs 4000px) and
  // make a ~300px thumb for instant, offline grid rendering.
  const processed = await manipulateAsync(p.asset.uri, [{ resize: { width: 1200 } }], {
    compress: 0.8,
    format: SaveFormat.JPEG,
  });
  const thumb = await manipulateAsync(processed.uri, [{ resize: { width: 300 } }], {
    compress: 0.7,
    format: SaveFormat.JPEG,
  });

  const guuid = Crypto.randomUUID();
  await FileSystem.makeDirectoryAsync(ATTACHMENTS_DIR, { intermediates: true });
  const localPath = `${ATTACHMENTS_DIR}${guuid}.jpg`;
  const localThumbPath = `${ATTACHMENTS_DIR}${guuid}_thumb.jpg`;
  await FileSystem.moveAsync({ from: processed.uri, to: localPath });
  await FileSystem.moveAsync({ from: thumb.uri, to: localThumbPath });

  // Hash the downsized bytes (small — the perf caveat about hashing giant files
  // doesn't apply post-resize). sha256 gives free dedupe + commit idempotency.
  const base64 = await FileSystem.readAsStringAsync(localPath, {
    encoding: FileSystem.EncodingType.Base64,
  });
  const sha256 = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, base64);
  const info = await FileSystem.getInfoAsync(localPath);
  const sizeBytes = info.exists ? info.size : null;

  // Persist the row (survives an app kill — the uploader's durable work-list).
  await attachmentRepository.insert(getSyncDb(), {
    guuid,
    storeFk: p.storeId,
    entityType: p.entityType,
    recordGuuid: p.recordGuuid,
    kind: p.kind ?? 'image',
    status: 'pending_upload',
    localPath,
    localThumbPath,
    mimeType: 'image/jpeg',
    sizeBytes,
    sha256,
    createdBy: p.userId,
    createdAt: Date.now(),
  });

  // Nudge the uploader (no-op offline / before the uploader is registered).
  requestImageUpload();
  return guuid;
}
