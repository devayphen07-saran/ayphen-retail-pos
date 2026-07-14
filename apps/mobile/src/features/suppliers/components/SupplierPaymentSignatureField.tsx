import { useMobileTheme } from '@ayphen/mobile-theme';
import { Alert, Row, Button } from '@ayphen/mobile-ui-components';
import { RecordImage, useRecordImageCapture } from '@features/attachments';

interface Props {
  storeId: string;
  /** Draft payment guuid, generated when the pay screen opened. */
  paymentGuuid: string;
  userId: string;
  disabled?: boolean;
}

/**
 * F6 (docs/prd/accounts-and-ledger.md) — vendor signature-of-receipt,
 * captured against the payment's draft guuid before Pay. Mirrors
 * ProductImageCaptureField's pattern exactly, entityType 'SupplierPayment' —
 * the background uploader propagates it once the payment's create mutation
 * has synced (image-offline-architecture.md).
 */
export function SupplierPaymentSignatureField({ storeId, paymentGuuid, userId, disabled }: Props) {
  const { theme } = useMobileTheme();
  const { captureFromLibrary, captureFromCamera, isCapturing } = useRecordImageCapture({
    storeId,
    entityType: 'SupplierPayment',
    recordGuuid: paymentGuuid,
    userId,
  });

  const open = () =>
    Alert.show('Capture signature', undefined, [
      { text: 'Photo Library', onPress: () => void captureFromLibrary() },
      { text: 'Take Photo', onPress: () => void captureFromCamera() },
      { text: 'Cancel', style: 'cancel' },
    ]);

  return (
    <Row gap={theme.sizing.medium} align="center">
      <RecordImage recordGuuid={paymentGuuid} label="Signature" size={88} />
      <Button
        label={isCapturing ? 'Capturing…' : 'Capture signature'}
        variant="default"
        iconName="PenLine"
        onPress={open}
        disabled={disabled || isCapturing}
        loading={isCapturing}
      />
    </Row>
  );
}