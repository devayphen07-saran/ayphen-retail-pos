import { useEffect, useMemo, useRef, useState } from 'react';
import type { ViewToken } from 'react-native';
import { useRecordFilesBatchQuery, type FileResponse } from '@ayphen/api-manager';
import { useDebouncedValue } from '../../../utils/useDebouncedValue';
import type { RemoteRecordImage } from './RecordImage';

/** Server cap on `record_guuids` per batched request (files.controller by-records). */
const MAX_BATCH = 100;

function pickImage(files: FileResponse[]): RemoteRecordImage | null {
  const img = files.find((f) => f.kind === 'image') ?? files[0];
  return img ? { guuid: img.guuid, url: img.url, thumbnailUrl: img.thumbnail_url } : null;
}

/**
 * Batched, viewability-driven remote-image lookup for a virtualized list
 * (P1-9/P1-10). Feeds `RecordImage`'s `remoteFile` so a NON-capturing device can
 * render another device's image — fetched once online, then served offline from
 * `expo-image`'s disk cache (keyed by the stable file guuid, since the presigned
 * `url` rotates every read).
 *
 * Why viewability, not fetch-all: a catalog can hold thousands of rows; minting a
 * presigned URL for every one on mount is the N+1-over-HTTP this design rejects.
 * We fetch only the rows currently on screen (≤ the visible window), debounced,
 * and ACCUMULATE results so a card keeps its image after scrolling past — bounded
 * to one small request per scroll-settle.
 *
 * Spread `viewabilityProps` onto the list (ListScaffold forwards top-level props
 * to FlashList); pass `remoteByGuuid.get(item.guuid)` as each card's `remoteFile`.
 * Offline, react-query pauses the request (networkMode 'online'), so nothing
 * fires and cards fall back to the local thumb or the initials placeholder.
 */
export function useRecordRemoteImages(storeId: string, entityType: string) {
  const [visible, setVisible] = useState<string[]>([]);

  // FlashList rejects a changing `onViewableItemsChanged`/`viewabilityConfig`
  // identity — keep both stable via refs while still reading the latest setter.
  const setVisibleRef = useRef(setVisible);
  setVisibleRef.current = setVisible;
  const viewabilityProps = useRef({
    onViewableItemsChanged: ({ viewableItems }: { viewableItems: ViewToken[] }) => {
      const guuids = viewableItems
        .map((v) => (v.item as { guuid?: string } | null)?.guuid)
        .filter((g): g is string => typeof g === 'string');
      setVisibleRef.current(guuids);
    },
    viewabilityConfig: { itemVisiblePercentThreshold: 10 },
  }).current;

  // Debounce + dedupe + sort → a stable query key that coalesces a scroll burst
  // and lets react-query cache identical windows. Capped at the server limit.
  const debounced = useDebouncedValue(visible, 250);
  const queryGuuids = useMemo(
    () => [...new Set(debounced)].sort().slice(0, MAX_BATCH),
    [debounced],
  );

  const { data } = useRecordFilesBatchQuery(storeId, entityType, queryGuuids);

  // Accumulate across windows; reuse the existing entry reference when the file
  // guuid is unchanged so memoized cards outside the current window never
  // re-render just because a URL rotated.
  const [remoteByGuuid, setRemoteByGuuid] = useState<Map<string, RemoteRecordImage>>(new Map());
  useEffect(() => {
    if (!data) return;
    setRemoteByGuuid((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const [recordGuuid, files] of Object.entries(data)) {
        const image = pickImage(files);
        const existing = prev.get(recordGuuid);
        if (image === null) {
          if (existing) {
            next.delete(recordGuuid);
            changed = true;
          }
          continue;
        }
        // Keep the stable ref if the file identity hasn't changed (URL rotation
        // alone doesn't matter — expo-image is keyed on the guuid cacheKey).
        if (existing && existing.guuid === image.guuid) continue;
        next.set(recordGuuid, image);
        changed = true;
      }
      return changed ? next : prev;
    });
  }, [data]);

  return { remoteByGuuid, viewabilityProps };
}