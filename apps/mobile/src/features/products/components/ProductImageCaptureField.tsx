import { Alert } from 'react-native';
import { Row, Button } from '@ayphen/mobile-ui-components';
import { RecordImage, useRecordImageCapture } from '../../attachments';

interface ProductImageCaptureFieldProps {
  storeId: string;
  /** Draft product guuid, generated when the form opened. */
  productGuuid: string;
  userId: string;
  label: string;
  disabled?: boolean;
}

/**
 * Offline product-image capture for the create form. Binds the polymorphic
 * capture/display primitives (RecordImage / useRecordImageCapture) to
 * `entityType: 'Product'`. The photo is captured against the draft product guuid
 * before Save — Save itself never waits, and the background uploader propagates
 * the image once the product's create mutation has synced.
 */
export function ProductImageCaptureField({
  storeId,
  productGuuid,
  userId,
  label,
  disabled,
}: ProductImageCaptureFieldProps) {
  const { captureFromLibrary, captureFromCamera, isCapturing } = useRecordImageCapture({
    storeId,
    entityType: 'Product',
    recordGuuid: productGuuid,
    userId,
  });

  const open = () =>
    Alert.alert('Add product photo', undefined, [
      { text: 'Photo Library', onPress: () => void captureFromLibrary() },
      { text: 'Take Photo', onPress: () => void captureFromCamera() },
      { text: 'Cancel', style: 'cancel' },
    ]);

  return (
    <Row gap={16} align="center">
      <RecordImage recordGuuid={productGuuid} label={label || 'Product'} size={88} />
      <Button
        label={isCapturing ? 'Adding…' : 'Add photo'}
        variant="default"
        iconName="Camera"
        onPress={open}
        disabled={disabled || isCapturing}
        loading={isCapturing}
      />
    </Row>
  );
}
