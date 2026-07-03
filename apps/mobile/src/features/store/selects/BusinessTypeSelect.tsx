import { ConfigSelectItem, SelectGeneric, Typography } from '@ayphen/mobile-ui-components';
import { useGlobalLookupQuery, type LookupValueResponse } from '@ayphen/api-manager';
import { useAuth } from '@core/providers/AuthProvider';

export const BUSINESS_CATEGORY_TYPE = 'BUSINESS_CATEGORY';

interface Props {
  value?: string;
  onChange: (code: string | undefined) => void;
  disabled?: boolean;
  errorMessage?: string;
}

/** Store business-type dropdown — global lookup, no store context required. */
export function BusinessTypeSelect({ value, onChange, disabled, errorMessage }: Props) {
  const { isAuthenticated } = useAuth();
  const { data, isLoading } = useGlobalLookupQuery(BUSINESS_CATEGORY_TYPE, {
    enabled: isAuthenticated,
  });
  const items = data ?? [];

  return (
    <SelectGeneric<LookupValueResponse>
      label="Business type (optional)"
      options={items}
      value={value}
      valueKey="code"
      onChange={(item) => onChange(item?.code)}
      disabled={disabled}
      loading={isLoading}
      noDataMessage="No business types available"
      errorMessage={errorMessage}
      keyExtractor={(item) => item.guuid}
      displayRenderer={(selected) => (
        <Typography.Body>{selected ? selected.label : 'Select business type'}</Typography.Body>
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
