import { useCallback, useState } from 'react';
import {
  useStageFileMutation,
  useCancelStagedMutation,
  type NormalizedError,
} from '@ayphen/api-manager';
import type { PickedAsset } from './useAttachmentPicker';

/** One in-flight / staged attachment tracked locally until the parent is saved. */
export interface AttachmentItem {
  localId: string;
  name: string;
  mimeType: string;
  /** Local device uri — kept for preview-before-staged and for retry. */
  sourceUri: string;
  /** What to render: the local uri while staging, the presigned preview once staged. */
  previewUri: string;
  status: 'uploading' | 'staged' | 'error';
  guuid?: string;
  error?: string;
}

interface UploaderParams {
  storeId: string;
  entityType: string;
  kind: string;
}

let counter = 0;
function nextLocalId(): string {
  counter += 1;
  return `att-${counter}`;
}

/**
 * Staging orchestration for the two-phase upload. Each picked asset is staged
 * immediately (owner-scoped temp) and tracked with per-item status so the UI can
 * show a spinner, an error+retry, or the staged thumbnail. The staged guuids are
 * held here until the parent record is saved, then handed to the commit call.
 */
export function useAttachmentUploader({ storeId, entityType, kind }: UploaderParams) {
  const [items, setItems] = useState<AttachmentItem[]>([]);
  const stage = useStageFileMutation();
  const cancel = useCancelStagedMutation();

  const buildFormData = useCallback(
    (asset: PickedAsset): FormData => {
      const form = new FormData();
      // React Native's FormData accepts a {uri,name,type} file part; the DOM lib
      // types don't model it, hence the cast.
      form.append('file', { uri: asset.uri, name: asset.name, type: asset.mimeType } as unknown as Blob);
      form.append('entity_type', entityType);
      form.append('kind', kind);
      return form;
    },
    [entityType, kind],
  );

  const stageOne = useCallback(
    async (localId: string, asset: PickedAsset) => {
      try {
        const res = await stage.mutateAsync({ pathParam: { storeId }, formData: buildFormData(asset) });
        setItems((prev) =>
          prev.map((it) =>
            it.localId === localId
              ? { ...it, status: 'staged', guuid: res.guuid, previewUri: res.preview_url, error: undefined }
              : it,
          ),
        );
      } catch (err) {
        const message = (err as NormalizedError)?.message ?? 'Upload failed';
        setItems((prev) =>
          prev.map((it) => (it.localId === localId ? { ...it, status: 'error', error: message } : it)),
        );
      }
    },
    [stage, storeId, buildFormData],
  );

  const addAssets = useCallback(
    async (assets: PickedAsset[]) => {
      const pending = assets.map((asset) => {
        const localId = nextLocalId();
        const item: AttachmentItem = {
          localId,
          name: asset.name,
          mimeType: asset.mimeType,
          sourceUri: asset.uri,
          previewUri: asset.uri,
          status: 'uploading',
        };
        return { item, asset };
      });
      setItems((prev) => [...prev, ...pending.map((p) => p.item)]);
      await Promise.all(pending.map((p) => stageOne(p.item.localId, p.asset)));
    },
    [stageOne],
  );

  const retry = useCallback(
    async (localId: string) => {
      const item = items.find((it) => it.localId === localId);
      if (!item) return;
      setItems((prev) =>
        prev.map((it) => (it.localId === localId ? { ...it, status: 'uploading', error: undefined } : it)),
      );
      await stageOne(localId, { uri: item.sourceUri, name: item.name, mimeType: item.mimeType, size: 0 });
    },
    [items, stageOne],
  );

  const remove = useCallback(
    async (localId: string) => {
      const item = items.find((it) => it.localId === localId);
      setItems((prev) => prev.filter((it) => it.localId !== localId));
      if (item?.status === 'staged' && item.guuid) {
        try {
          await cancel.mutateAsync({ pathParam: { storeId, guuid: item.guuid } });
        } catch {
          // Best-effort — the server-side sweeper reaps abandoned temps at TTL.
        }
      }
    },
    [items, cancel, storeId],
  );

  /** Cancel every still-staged upload (e.g. the user backed out of the form). */
  const cancelAll = useCallback(async () => {
    const guuids = items.filter((it) => it.status === 'staged' && it.guuid).map((it) => it.guuid!);
    setItems([]);
    await Promise.all(
      guuids.map((guuid) => cancel.mutateAsync({ pathParam: { storeId, guuid } }).catch(() => undefined)),
    );
  }, [items, cancel, storeId]);

  /** Drop local state after a successful commit (temps are now permanent files). */
  const reset = useCallback(() => setItems([]), []);

  const stagedGuuids = items.filter((it) => it.status === 'staged' && it.guuid).map((it) => it.guuid!);
  const isUploading = items.some((it) => it.status === 'uploading');
  const hasErrors = items.some((it) => it.status === 'error');

  return { items, addAssets, retry, remove, cancelAll, reset, stagedGuuids, isUploading, hasErrors };
}
