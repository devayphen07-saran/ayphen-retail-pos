import styled from 'styled-components/native';
import { useMobileTheme } from '@ayphen/mobile-theme';
import { Column, LucideIcon, Row, SheetConfirmActions, Typography } from '@ayphen/mobile-ui-components';

export interface ConfirmCheckoutSheetProps {
  displayName: string;
  priceLabel: string;
  isDowngrade: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmCheckoutSheet({ displayName, priceLabel, isDowngrade, onConfirm, onCancel }: ConfirmCheckoutSheetProps) {
  const { theme } = useMobileTheme();
  return (
    // The sheet shell gives this a fixed height (snapPoint 'sm'), not a
    // fit-to-content one — space-between anchors the actions to the bottom
    // instead of leaving the rest of that fixed height blank under them.
    <Column style={{ flex: 1, justifyContent: 'space-between', paddingHorizontal: theme.sizing.medium, paddingTop: theme.sizing.medium }}>
      <Column gap={4}>
        <Typography.Body type="secondary">{displayName}</Typography.Body>
        <Typography.H3 weight="bold">{priceLabel}</Typography.H3>
        <Typography.Caption type="secondary">
          You'll be redirected to Razorpay to complete payment.
        </Typography.Caption>
        {isDowngrade && (
          <DowngradeWarning align="flex-start" gap={8}>
            <LucideIcon name="TriangleAlert" size={15} color={theme.colorWarning} />
            <Typography.Caption color={theme.colorWarning} style={{ flex: 1 }}>
              Downgrading may lock stores, locations, or devices over your new plan's limits.
              Nothing is deleted, and you'll be able to choose what to keep.
            </Typography.Caption>
          </DowngradeWarning>
        )}
      </Column>
      <SheetConfirmActions confirmLabel="Continue" onConfirm={onConfirm} onCancel={onCancel} />
    </Column>
  );
}

const DowngradeWarning = styled(Row)`
  background-color: ${({ theme }) => theme.colorWarningBg};
  border-radius: ${({ theme }) => theme.borderRadius.medium}px;
  padding: ${({ theme }) => theme.sizing.small}px;
  margin-top: ${({ theme }) => theme.sizing.xSmall}px;
`;