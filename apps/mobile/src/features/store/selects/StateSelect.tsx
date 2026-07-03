import { ConfigSelectItem, SelectGeneric, Typography } from '@ayphen/mobile-ui-components';
import { useStatesQuery, type LookupValueResponse } from '@ayphen/api-manager';
import { useAuth } from '@core/providers/AuthProvider';

interface Props {
  value?: string;
  onChange: (gstStateCode: string | undefined) => void;
  disabled?: boolean;
  errorMessage?: string;
}

/** State / union-territory dropdown — value is the 2-digit GST state code. */
export function StateSelect({ value, onChange, disabled, errorMessage }: Props) {
  const { isAuthenticated } = useAuth();
  const { data, isLoading } = useStatesQuery({ enabled: isAuthenticated });
  const items = data ?? [];

  return (
    <SelectGeneric<LookupValueResponse>
      label="State (optional)"
      options={items}
      value={value}
      valueKey="code"
      onChange={(item) => onChange(item?.code)}
      disabled={disabled}
      loading={isLoading}
      noDataMessage="No states available"
      errorMessage={errorMessage}
      keyExtractor={(item) => item.guuid}
      displayRenderer={(selected) => (
        <Typography.Body>{selected ? selected.label : 'Select state'}</Typography.Body>
      )}
      renderItem={(item, onSelect, isSelected) => (
        <ConfigSelectItem
          title={item.label}
          isSelected={isSelected}
          disabled={false}
          onPress={() => onSelect(item)}
        />
      )}
    />
  );
}
