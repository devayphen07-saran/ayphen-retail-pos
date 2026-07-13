import { useCallback } from 'react';
import { Alert, Linking } from 'react-native';
import * as ImagePicker from 'expo-image-picker';

/** A picked local asset, normalized to the fields the upload FormData needs. */
export interface PickedAsset {
  uri: string;
  name: string;
  mimeType: string;
  size: number;
}

/** Derive a filename with an extension from a content/file uri when the OS gives none. */
function fileNameFromUri(uri: string, fallbackExt: string): string {
  const last = uri.split('/').pop() || `upload.${fallbackExt}`;
  return last.includes('.') ? last : `${last}.${fallbackExt}`;
}

function toAsset(a: ImagePicker.ImagePickerAsset): PickedAsset {
  const mimeType = a.mimeType ?? 'image/jpeg';
  const ext = mimeType.split('/')[1] ?? 'jpg';
  return {
    uri: a.uri,
    name: a.fileName ?? fileNameFromUri(a.uri, ext),
    mimeType,
    size: a.fileSize ?? 0,
  };
}

/** Prompt the user to open Settings when a permission is permanently denied. */
function permissionAlert(kind: 'photos' | 'camera'): void {
  const what = kind === 'photos' ? 'photo library' : 'camera';
  Alert.alert(
    'Permission needed',
    `Enable ${what} access for this app in Settings to attach photos.`,
    [
      { text: 'Not now', style: 'cancel' },
      { text: 'Open Settings', onPress: () => void Linking.openSettings() },
    ],
  );
}

/**
 * Photo picker/capture wrapper. Requests permission first and surfaces a clear
 * denial prompt (the old app silently no-op'd on denial); returns [] on
 * cancel/denial so callers never have to special-case those. Images are
 * re-encoded at quality 0.7 to keep uploads small — the server is still the real
 * size/type gate.
 */
export function useAttachmentPicker() {
  const pickFromLibrary = useCallback(
    async (opts?: { allowsMultiple?: boolean; selectionLimit?: number }): Promise<PickedAsset[]> => {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        if (!perm.canAskAgain) permissionAlert('photos');
        return [];
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        quality: 0.7,
        allowsMultipleSelection: opts?.allowsMultiple ?? false,
        selectionLimit: opts?.selectionLimit ?? 0,
      });
      if (result.canceled) return [];
      return result.assets.map(toAsset);
    },
    [],
  );

  const pickFromCamera = useCallback(async (): Promise<PickedAsset[]> => {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      if (!perm.canAskAgain) permissionAlert('camera');
      return [];
    }
    const result = await ImagePicker.launchCameraAsync({ quality: 0.7 });
    if (result.canceled) return [];
    return result.assets.map(toAsset);
  }, []);

  return { pickFromLibrary, pickFromCamera };
}
