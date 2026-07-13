import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
} from 'react';
import { ActivityIndicator, Alert, Pressable, View } from 'react-native';
import { Image } from 'expo-image';
import { useMobileTheme } from '@ayphen/mobile-theme';
import { Column, Row, Typography, LucideIcon } from '@ayphen/mobile-ui-components';
import type { FileResponse } from '@ayphen/api-manager';
import { useAttachmentPicker } from '../hooks/useAttachmentPicker';
import { useAttachmentUploader } from '../hooks/useAttachmentUploader';

const THUMB = 76;

/** Reactive state pushed to the parent so it can gate its Save button + commit. */
export interface AttachmentFieldState {
  stagedGuuids: string[];
  isUploading: boolean;
  hasErrors: boolean;
}

/** Imperative handle for the parent to call once the parent record is saved. */
export interface AttachmentFieldHandle {
  reset: () => void;
  cancelAll: () => Promise<void>;
}

interface AttachmentFieldProps {
  storeId: string;
  entityType: string;
  kind: string;
  label?: string;
  /** Max total attachments (existing committed + newly staged). Mirrors the server rule for UX. */
  max?: number;
  /** Already-committed files (edit screen) — rendered with a delete control. */
  existingFiles?: FileResponse[];
  onDeleteExisting?: (guuid: string) => void;
  onChange?: (state: AttachmentFieldState) => void;
  disabled?: boolean;
}

/**
 * Reusable image-attachment field for a parent form. Owns the staging lifecycle
 * (pick → stage → track) and surfaces the staged guuids to the parent via
 * `onChange`; the parent commits them on save and calls `reset()` on the ref.
 * The add control is disabled while any upload is in flight (the double-tap
 * guard the old app lacked) and once `max` is reached.
 */
export const AttachmentField = forwardRef<AttachmentFieldHandle, AttachmentFieldProps>(
  function AttachmentField(
    { storeId, entityType, kind, label, max, existingFiles = [], onDeleteExisting, onChange, disabled },
    ref,
  ) {
    const { theme } = useMobileTheme();
    const { pickFromLibrary, pickFromCamera } = useAttachmentPicker();
    const uploader = useAttachmentUploader({ storeId, entityType, kind });
    const { items, addAssets, retry, remove, cancelAll, reset, stagedGuuids, isUploading, hasErrors } = uploader;

    useImperativeHandle(ref, () => ({ reset, cancelAll }), [reset, cancelAll]);

    // Push reactive state up whenever it changes (join keys keep this stable).
    const stagedKey = stagedGuuids.join(',');
    const onChangeRef = useRef(onChange);
    onChangeRef.current = onChange;
    useEffect(() => {
      onChangeRef.current?.({ stagedGuuids: stagedKey ? stagedKey.split(',') : [], isUploading, hasErrors });
    }, [stagedKey, isUploading, hasErrors]);

    const total = existingFiles.length + items.length;
    const atLimit = max !== undefined && total >= max;
    const canAdd = !disabled && !atLimit;

    const openPicker = () => {
      Alert.alert(label ?? 'Add photo', undefined, [
        { text: 'Photo Library', onPress: () => void pickFromLibrary().then(addAssets) },
        { text: 'Take Photo', onPress: () => void pickFromCamera().then(addAssets) },
        { text: 'Cancel', style: 'cancel' },
      ]);
    };

    const tile = {
      width: THUMB,
      height: THUMB,
      borderRadius: theme.borderRadius.large,
      overflow: 'hidden' as const,
      backgroundColor: theme.colorBgContainer,
      borderWidth: theme.borderWidth.thin,
      borderColor: theme.colorBorderSecondary,
    };

    return (
      <Column gap={8}>
        {label ? (
          <Row justify="space-between" align="center">
            <Typography.Body color={theme.colorText}>{label}</Typography.Body>
            {max !== undefined ? (
              <Typography.Caption color={theme.colorTextSecondary}>
                {total}/{max}
              </Typography.Caption>
            ) : null}
          </Row>
        ) : null}

        <Row gap={10} wrap="wrap" align="center">
          {existingFiles.map((f) => (
            <View key={f.guuid} style={tile}>
              <Image source={{ uri: f.url }} style={{ width: '100%', height: '100%' }} contentFit="cover" />
              {onDeleteExisting && !disabled ? (
                <RemoveBadge theme={theme} onPress={() => onDeleteExisting(f.guuid)} />
              ) : null}
            </View>
          ))}

          {items.map((it) => (
            <View key={it.localId} style={tile}>
              <Image source={{ uri: it.previewUri }} style={{ width: '100%', height: '100%' }} contentFit="cover" />

              {it.status === 'uploading' ? (
                <Overlay bg="rgba(0,0,0,0.35)">
                  <ActivityIndicator color={theme.colorWhite} />
                </Overlay>
              ) : null}

              {it.status === 'error' ? (
                <Pressable onPress={() => void retry(it.localId)} style={{ position: 'absolute', inset: 0 }}>
                  <Overlay bg="rgba(0,0,0,0.45)">
                    <LucideIcon name="RefreshCw" size={20} color={theme.colorWhite} />
                  </Overlay>
                </Pressable>
              ) : null}

              {!disabled ? <RemoveBadge theme={theme} onPress={() => void remove(it.localId)} /> : null}
            </View>
          ))}

          {canAdd ? (
            <Pressable
              onPress={openPicker}
              accessibilityRole="button"
              accessibilityLabel={label ?? 'Add photo'}
              style={[
                tile,
                { alignItems: 'center', justifyContent: 'center', borderStyle: 'dashed', borderColor: theme.colorBorder },
              ]}
            >
              <LucideIcon name="Plus" size={24} color={theme.colorTextSecondary} />
            </Pressable>
          ) : null}
        </Row>

        {hasErrors ? (
          <Typography.Caption color={theme.colorError}>
            Some uploads failed — tap a photo to retry.
          </Typography.Caption>
        ) : null}
      </Column>
    );
  },
);

/** Small circular "X" overlaid on a thumbnail's top-right corner. */
function RemoveBadge({
  theme,
  onPress,
}: {
  theme: ReturnType<typeof useMobileTheme>['theme'];
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel="Remove photo"
      style={{
        position: 'absolute',
        top: 2,
        right: 2,
        width: 20,
        height: 20,
        borderRadius: 10,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(0,0,0,0.55)',
      }}
    >
      <LucideIcon name="X" size={13} color={theme.colorWhite} />
    </Pressable>
  );
}

function Overlay({ bg, children }: { bg: string; children: React.ReactNode }) {
  return (
    <View
      style={{
        position: 'absolute',
        inset: 0,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: bg,
      }}
    >
      {children}
    </View>
  );
}
