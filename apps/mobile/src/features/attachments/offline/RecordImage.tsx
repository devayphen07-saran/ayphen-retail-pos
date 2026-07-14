import { useMemo, useState } from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';
import { Image } from 'expo-image';
import { useMobileTheme } from '@ayphen/mobile-theme';
import {
  LucideIcon,
  Typography,
  type LucideIconNameType,
} from '@ayphen/mobile-ui-components';

import type { AttachmentStatus } from '@core/sync/repositories/attachment.repository';

import { useRecordImage } from './useRecordImage';

export interface RemoteRecordImage {
  /** Stable identifier used as the image cache key. */
  guuid: string;
  /** Rotating presigned URL for the original image. */
  url: string;
  /** Rotating presigned URL for the thumbnail, when available. */
  thumbnailUrl?: string | null;
}

interface RecordImageProps {
  /** Parent record's client-generated GUUID. */
  recordGuuid: string;

  /** Record label used to generate the initials placeholder. */
  label: string;

  /** Server image returned by the batched record-image request. */
  remoteFile?: RemoteRecordImage | null;

  size?: number;
  radius?: number;

  /**
   * Fill the parent's width as a square (width 100%, aspectRatio 1) instead of a
   * fixed `size`. Use in grid tiles so the image always spans the cell exactly.
   */
  fill?: boolean;

  /**
   * Displays the local upload-state badge.
   *
   * Disable this on selling surfaces where upload state is unnecessary noise.
   */
  showStatusBadge?: boolean;
}

interface StatusBadge {
  icon: LucideIconNameType;
  tone: 'muted' | 'warn';
}

function initialsFrom(label: string): string {
  const parts = label.trim().split(/\s+/).filter(Boolean);

  if (parts.length === 0) {
    return '?';
  }

  if (parts.length === 1) {
    return parts[0]?.slice(0, 1).toUpperCase() || '?';
  }

  const firstInitial = parts[0]?.slice(0, 1) ?? '';
  const lastInitial = parts.at(-1)?.slice(0, 1) ?? '';

  return `${firstInitial}${lastInitial}`.toUpperCase() || '?';
}

function statusBadge(status: AttachmentStatus): StatusBadge | null {
  switch (status) {
    case 'pending_upload':
    case 'staging':
    case 'staged':
    case 'committing':
      return {
        icon: 'CloudUpload',
        tone: 'muted',
      };

    case 'blocked':
      return {
        icon: 'Lock',
        tone: 'muted',
      };

    case 'failed':
      return {
        icon: 'TriangleAlert',
        tone: 'warn',
      };

    case 'committed':
    case 'orphaned':
    default:
      return null;
  }
}

/**
 * Offline-first record thumbnail.
 *
 * Resolution order:
 *
 * 1. Local thumbnail.
 * 2. Remote server image.
 * 3. Initials placeholder.
 *
 * If a local image fails to load, the component falls back to the remote
 * image. If the remote image also fails, it falls back to the placeholder.
 */
export function RecordImage({
  recordGuuid,
  label,
  remoteFile,
  size = 76,
  radius,
  fill = false,
  showStatusBadge = true,
}: RecordImageProps) {
  const { theme } = useMobileTheme();
  const local = useRecordImage(recordGuuid);

  /*
   * Store the exact URI that failed instead of a boolean. When the URI changes,
   * the new image is automatically attempted without needing an effect to
   * reset failure state.
   */
  const [failedLocalUri, setFailedLocalUri] = useState<string | null>(null);
  const [failedRemoteUri, setFailedRemoteUri] = useState<string | null>(null);

  const localUri = local?.localThumbPath?.trim() || null;

  const remoteUri =
    remoteFile?.thumbnailUrl?.trim() || remoteFile?.url?.trim() || null;

  const canUseLocal = localUri !== null && localUri !== failedLocalUri;

  const canUseRemote =
    remoteFile !== null &&
    remoteFile !== undefined &&
    remoteUri !== null &&
    remoteUri !== failedRemoteUri;

  const badge = showStatusBadge && local ? statusBadge(local.status) : null;

  const containerStyle = useMemo<ViewStyle>(
    () => ({
      ...(fill
        ? { width: '100%', aspectRatio: 1 }
        : { width: Math.max(0, size), height: Math.max(0, size) }),
      borderRadius: radius ?? theme.borderRadius.large,
      overflow: 'hidden',
      backgroundColor: theme.colorBgContainer,
    }),
    [fill, radius, size, theme.borderRadius.large, theme.colorBgContainer],
  );

  let content: React.ReactNode;

  if (canUseLocal) {
    content = (
      <Image
        source={{ uri: localUri }}
        style={styles.image}
        contentFit="cover"
        transition={0}
        recyclingKey={`${recordGuuid}:local:${localUri}`}
        onError={() => {
          setFailedLocalUri(localUri);
        }}
      />
    );
  } else if (canUseRemote && remoteFile) {
    content = (
      <Image
        source={{
          uri: remoteUri,
          cacheKey: remoteFile.guuid,
        }}
        style={styles.image}
        contentFit="cover"
        cachePolicy="disk"
        transition={0}
        recyclingKey={`${recordGuuid}:remote:${remoteFile.guuid}`}
        onError={() => {
          setFailedRemoteUri(remoteUri);
        }}
      />
    );
  } else {
    content = (
      <View
        style={[
          styles.placeholder,
          {
            backgroundColor: theme.color.primary.bg,
          },
        ]}
      >
        <Typography.H4 color={theme.color.primary.main}>
          {initialsFrom(label)}
        </Typography.H4>
      </View>
    );
  }

  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={`${label.trim() || 'Record'} image`}
      style={containerStyle}
    >
      {content}

      {badge ? (
        <View
          accessible={false}
          importantForAccessibility="no-hide-descendants"
          pointerEvents="none"
          style={[
            styles.badge,
            {
              backgroundColor:
                badge.tone === 'warn'
                  ? theme.colorError
                  : 'rgba(0, 0, 0, 0.55)',
            },
          ]}
        >
          <LucideIcon name={badge.icon} size={11} color={theme.colorWhite} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  image: {
    width: '100%',
    height: '100%',
  },

  placeholder: {
    width: '100%',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },

  badge: {
    position: 'absolute',
    right: 3,
    bottom: 3,
    width: 18,
    height: 18,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
