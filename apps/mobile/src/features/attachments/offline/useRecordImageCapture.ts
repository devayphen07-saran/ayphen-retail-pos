import { useCallback, useState } from 'react';
import { useAttachmentPicker, type PickedAsset } from '../hooks/useAttachmentPicker';
import { persistCapturedImage } from './persistCapturedImage';

interface CaptureParams {
  storeId: string;
  /** Polymorphic parent entity code — 'Product', 'Customer', 'Supplier', … */
  entityType: string;
  /** Parent record's client guuid. */
  recordGuuid: string;
  /** File kind — defaults to 'image'. */
  kind?: string;
  userId: string;
}

/**
 * Offline image capture for any record's parent form (image-offline-architecture.md
 * §C5 capture). Polymorphic — not tied to products; pass the parent `entityType`
 * + `recordGuuid`. Wraps the picker + local persist pipeline and exposes an
 * `isCapturing` lock: the capture-control lock that is half of the double-tap fix
 * (P1-13). Save never awaits any of this.
 */
export function useRecordImageCapture(params: CaptureParams) {
  const { pickFromLibrary, pickFromCamera } = useAttachmentPicker();
  const [isCapturing, setIsCapturing] = useState(false);

  const run = useCallback(
    async (pick: () => Promise<PickedAsset[]>): Promise<string | null> => {
      if (isCapturing) return null; // capture-control lock (P1-13)
      setIsCapturing(true);
      try {
        const [asset] = await pick();
        if (!asset) return null; // cancelled or permission denied
        return await persistCapturedImage({ asset, ...params });
      } finally {
        setIsCapturing(false);
      }
    },
    [isCapturing, params],
  );

  return {
    isCapturing,
    captureFromLibrary: () => run(pickFromLibrary),
    captureFromCamera: () => run(pickFromCamera),
  };
}
