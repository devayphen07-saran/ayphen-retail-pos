import { ConfigSelectItem, SelectGeneric, Typography } from '@ayphen/mobile-ui-components';
import type { PaymentAccountKind } from '@ayphen/api-manager';

interface KindOption {
  value: PaymentAccountKind;
  label: string;
}

const OPTIONS: KindOption[] = [
  { value: 'cash', label: 'Cash' },
  { value: 'bank', label: 'Bank' },
  { value: 'upi', label: 'UPI' },
  { value: 'card', label: 'Card' },
  { value: 'wallet', label: 'Wallet' },
  { value: 'other', label: 'Other' },
];

interface Props {
  value?: PaymentAccountKind;
  onChange: (kind: PaymentAccountKind | undefined) => void;
  disabled?: boolean;
  errorMessage?: string;
}

/** Account-channel picker (static enum). Replaces the old method-catalogue link. */
export function PaymentKindSelect({ value, onChange, disabled, errorMessage }: Props) {
  return (
    <SelectGeneric<KindOption>
      label="Type (optional)"
      options={OPTIONS}
      value={value}
      valueKey="value"
      onChange={(o) => onChange(o?.value)}
      disabled={disabled}
      errorMessage={errorMessage}
      noDataMessage="No types available"
      keyExtractor={(o) => o.value}
      displayRenderer={(selected) => (
        <Typography.Body>{selected ? selected.label : 'Select a type'}</Typography.Body>
      )}
      renderItem={(o, onSelect, isSelected) => (
        <ConfigSelectItem
          title={o.label}
          isSelected={isSelected}
          disabled={false}
          onPress={() => onSelect(o)}
        />
      )}
    />
  );
}
