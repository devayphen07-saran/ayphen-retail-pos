import { useMemo } from 'react';
import { View } from 'react-native';
import { Image } from 'expo-image';
import { useMobileTheme } from '@ayphen/mobile-theme';
import { Typography, LucideIcon, type LucideIconNameType } from '@ayphen/mobile-ui-components';
import type { AttachmentStatus } from '@core/sync/repositories/attachment.repository';
import { useRecordImage } from './useRecordImage';

/** A server file for a record, as returned by the batched grid read (FileResponse). */
export interface RemoteRecordImage {
  guuid: string; // stable cacheKey — the presigned `url` rotates every read (P1-9)
  url: string;
  thumbnailUrl?: string | null;
}

interface RecordImageProps {
  /** Parent record's client guuid. */
  recordGuuid: string;
  /** A label (e.g. product/customer name) — drives the initials placeholder when there's no image. */
  label: string;
  /** Server file for this record (batched fetch), used when this device has no local capture. */
  remoteFile?: RemoteRecordImage | null;
  size?: number;
  radius?: number;
}

/** Initials from a label — "Basmati Rice" → "BR", "Sugar" → "S". */
function initialsFrom(label: string): string {
  const parts = label.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 1).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

/** Ambient upload-state badge for the capturing device's local image. */
function statusBadge(status: AttachmentStatus): { icon: LucideIconNameType; tone: 'muted' | 'warn' } | null {
  switch (status) {
    case 'pending_upload':
    case 'staging':
    case 'staged':
    case 'committing':
      return { icon: 'CloudUpload', tone: 'muted' };
    case 'blocked':
      return { icon: 'Lock', tone: 'muted' };
    case 'failed':
      return { icon: 'TriangleAlert', tone: 'warn' };
    case 'committed':
    case 'orphaned':
      return null;
  }
}

/**
 * Record thumbnail with the offline-first resolution order
 * (image-offline-architecture.md §C5 display). Polymorphic — works for any
 * entity's record, not just products:
 *   1. local thumbnail  — instant, offline, before AND after upload (capturing device)
 *   2. remote file      — via expo-image with a STABLE cacheKey so the rotating
 *                         presigned URL doesn't defeat the disk cache (P1-9)
 *   3. designed placeholder — initials on a tokenized ground; never a broken-image icon.
 * Background upload state shows as a small corner badge, never a spinner over the
 * image — the image is already usable.
 */
export function RecordImage({ recordGuuid, label, remoteFile, size = 76, radius }: RecordImageProps) {
  const { theme } = useMobileTheme();
  const local = useRecordImage(recordGuuid);

  const box = {
    width: size,
    height: size,
    borderRadius: radius ?? theme.borderRadius.large,
    overflow: 'hidden' as const,
    backgroundColor: theme.colorBgContainer,
  };

  const badge = local ? statusBadge(local.status) : null;

  const content = useMemo(() => {
    // 1. Local thumbnail — the capturing device, instant and offline.
    if (local?.localThumbPath) {
      return (
        <Image
          source={{ uri: local.localThumbPath }}
          style={{ width: '100%', height: '100%' }}
          contentFit="cover"
          transition={0}
        />
      );
    }
    // 2. Remote — stable cacheKey (guuid), rotating presigned uri.
    if (remoteFile) {
      return (
        <Image
          source={{ uri: remoteFile.thumbnailUrl ?? remoteFile.url, cacheKey: remoteFile.guuid }}
          style={{ width: '100%', height: '100%' }}
          contentFit="cover"
          cachePolicy="disk"
          transition={0}
        />
      );
    }
    // 3. Designed placeholder — initials, never a broken image.
    return (
      <View style={{ width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center' }}>
        <Typography.H4 color={theme.colorTextSecondary}>{initialsFrom(label)}</Typography.H4>
      </View>
    );
  }, [local?.localThumbPath, remoteFile, label, theme.colorTextSecondary]);

  return (
    <View style={box} accessibilityLabel={`${label} image`}>
      {content}
      {badge ? (
        <View
          style={{
            position: 'absolute',
            bottom: 3,
            right: 3,
            width: 18,
            height: 18,
            borderRadius: 9,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: badge.tone === 'warn' ? theme.colorError : 'rgba(0,0,0,0.55)',
          }}
        >
          <LucideIcon name={badge.icon} size={11} color={theme.colorWhite} />
        </View>
      ) : null}
    </View>
  );
}
