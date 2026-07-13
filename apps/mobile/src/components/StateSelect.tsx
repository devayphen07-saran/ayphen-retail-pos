import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ConfigSelectItem, SelectGeneric, Typography } from '@ayphen/mobile-ui-components';
import { useStatesQuery, prefetchStates, type LookupValueResponse } from '@ayphen/api-manager';
import { useAuth } from '@core/providers/AuthProvider';

/**
 * Warm the states cache (C-address / offline). Call from a screen that reliably
 * precedes the create form while the device is likely online — the Customers /
 * Suppliers list screens — so `StateSelect` can render the list even if the
 * create form is later opened offline within the same session. Mirrors the
 * onboarding prefetch; idempotent and gated on auth.
 */
export function usePrefetchStates(): void {
  const { isAuthenticated } = useAuth();
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!isAuthenticated) return;
    void prefetchStates(queryClient);
  }, [isAuthenticated, queryClient]);
}

interface Props {
  /** The selected state's `guuid` — this is what `state_lookup_guuid` expects on
   *  the wire (the backend resolves it to `state_lookup_fk`). */
  value?: string;
  onChange: (guuid: string | undefined) => void;
  disabled?: boolean;
  errorMessage?: string;
}

/**
 * State/UT dropdown, backed by the dedicated Indian-states query
 * (`useStatesQuery`, key ["lookup","states"]) — the same query onboarding warms
 * via `prefetchStates`, and the one the customer/supplier LIST screens prefetch
 * (usePrefetchStates) before the create form opens. Binding is the lookup
 * `guuid` (the `state_lookup_guuid` shape both mutation handlers resolve), not
 * free text — this is the one referential address field.
 *
 * Because the list is prefetched into the TanStack cache, it's available OFFLINE
 * inside a session once it has been fetched once online. (The RN query cache is
 * in-memory only, so a cold app start with no connectivity still shows an empty
 * list — state is optional, so that degrades gracefully; full cold-offline would
 * need cache persistence or syncing the states into local SQLite.)
 */
export function StateSelect({ value, onChange, disabled, errorMessage }: Props) {
  const { isAuthenticated } = useAuth();
  const { data, isLoading, isError } = useStatesQuery({ enabled: isAuthenticated });
  const items = data ?? [];

  return (
    <SelectGeneric<LookupValueResponse>
      label="State (optional)"
      options={items}
      value={value}
      valueKey="guuid"
      onChange={(item) => onChange(item?.guuid)}
      disabled={disabled}
      loading={isLoading}
      noDataMessage={
        isError
          ? "Couldn't load states. Check your connection and reopen."
          : 'No states available'
      }
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
