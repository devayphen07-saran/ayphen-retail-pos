import { memo } from 'react';
import { TouchableOpacity } from 'react-native';
import { useMobileTheme } from '@ayphen/mobile-theme';
import { Column, Typography } from '@ayphen/mobile-ui-components';

export interface PaymentAccountCardProps {
  name: string;
  isDefault?: boolean | null;
  isActive?: boolean | null;
  isSystem?: boolean | null;
  /** Navigates to the account's cash-in/cash-out ledger
   *  (docs/prd/accounts-and-ledger.md §5). Omit to render read-only. */
  onPress?: () => void;
}

/** Presentational row — takes plain props so both the online management list
 *  (PaymentAccountResponse) and the offline checkout cache (LocalPaymentAccount)
 *  can render it. */
export const PaymentAccountCard = memo(function PaymentAccountCard({
  name,
  isDefault,
  isActive,
  isSystem,
  onPress,
}: PaymentAccountCardProps) {
  const { theme } = useMobileTheme();
  const inactive = isActive === false;
  const tags = [isDefault ? 'Default' : null, isSystem ? 'Built-in' : null, inactive ? 'Inactive' : null]
    .filter(Boolean)
    .join(' · ');

  const content = (
    <Column
      gap={2}
      style={{
        paddingVertical: theme.sizing.small,
        paddingHorizontal: theme.sizing.medium,
        opacity: inactive ? 0.5 : 1,
      }}
    >
      <Typography.Body weight="medium">{name}</Typography.Body>
      {tags ? <Typography.Caption type="secondary">{tags}</Typography.Caption> : null}
    </Column>
  );

  if (!onPress) return content;
  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.7} accessibilityRole="button">
      {content}
    </TouchableOpacity>
  );
});
