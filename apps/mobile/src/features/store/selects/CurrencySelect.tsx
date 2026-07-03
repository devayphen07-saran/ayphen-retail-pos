import { ConfigSelectItem, SelectGeneric, Typography } from '@ayphen/mobile-ui-components';
import { useCurrenciesQuery, type CurrencyResponse } from '@ayphen/api-manager';
import { useAuth } from '@core/providers/AuthProvider';

interface Props {
  value?: string;
  onChange: (code: string | undefined) => void;
  disabled?: boolean;
  errorMessage?: string;
}

const display = (c: CurrencyResponse): string => `${c.symbol} ${c.code} — ${c.name}`;

/** Currency dropdown — value is the ISO 4217 code. */
export function CurrencySelect({ value, onChange, disabled, errorMessage }: Props) {
  const { isAuthenticated } = useAuth();
  const { data, isLoading } = useCurrenciesQuery({ enabled: isAuthenticated });
  const items = data ?? [];

  return (
    <SelectGeneric<CurrencyResponse>
      label="Currency (optional)"
      options={items}
      value={value}
      valueKey="code"
      onChange={(item) => onChange(item?.code)}
      disabled={disabled}
      loading={isLoading}
      noDataMessage="No currencies available"
      errorMessage={errorMessage}
      keyExtractor={(item) => item.code}
      displayRenderer={(selected) => (
        <Typography.Body>{selected ? display(selected) : 'Select currency'}</Typography.Body>
      )}
      renderItem={(item, onSelect, isSelected) => (
        <ConfigSelectItem
          title={display(item)}
          isSelected={isSelected}
          disabled={false}
          onPress={() => onSelect(item)}
        />
      )}
    />
  );
}
