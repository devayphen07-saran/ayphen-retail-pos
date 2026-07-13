import { Input } from '@ayphen/mobile-ui-components';
import {
  Controller,
  type Control,
  type FieldPath,
  type FieldValues,
  type UseFormReturn,
} from 'react-hook-form';
import { FormFieldAnchor } from './FormScreen';
import { StateSelect } from './StateSelect';

/**
 * The address fields every party form (customer, supplier, …) shares — the
 * mobile equivalent of the portal's dedicated address form, right-sized to this
 * app: flat, offline-first text fields plus a referential State dropdown
 * (backed by the global STATE lookup), rather than the portal's server-config
 * Country→State→City cascade (which would need country/city reference data
 * synced to the device). One component, one source of truth — no drift between
 * the customer and supplier address blocks.
 *
 * Every consuming form's schema must carry these keys (all optional strings),
 * which is enforced by the `AddressFormShape` constraint on `T`.
 */
export type AddressFormShape = {
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  district?: string;
  /** Holds the selected STATE lookup's `guuid` (→ `state_lookup_guuid` on the
   *  wire), not free text — this is the one referential address field. */
  state?: string;
  pinCode?: string;
};

interface AddressFieldsProps<T extends FieldValues> {
  control: Control<T>;
  form: UseFormReturn<T>;
  registerFieldOffset: (name: string, y: number) => void;
  disabled?: boolean;
  /** What to focus after the last address field (PIN) — e.g. the form's next
   *  field: `() => form.setFocus('notes')`. Keeps keyboard "next" chaining
   *  continuous across the extracted block. */
  onPinSubmit?: () => void;
}

export function AddressFields<T extends FieldValues & AddressFormShape>({
  control,
  form,
  registerFieldOffset,
  disabled,
  onPinSubmit,
}: AddressFieldsProps<T>) {
  // T is constrained to include the address keys, so these casts are sound —
  // they only narrow the shared literal keys to this form's FieldPath.
  const path = (key: keyof AddressFormShape) => key as FieldPath<T>;

  return (
    <>
      <FormFieldAnchor name="addressLine1" registerFieldOffset={registerFieldOffset}>
        <Input<T>
          name={path('addressLine1')}
          control={control}
          label="Address line 1 (optional)"
          disabled={disabled}
          returnKeyType="next"
          onSubmitEditing={() => form.setFocus(path('addressLine2'))}
        />
      </FormFieldAnchor>
      <FormFieldAnchor name="addressLine2" registerFieldOffset={registerFieldOffset}>
        <Input<T>
          name={path('addressLine2')}
          control={control}
          label="Address line 2 (optional)"
          disabled={disabled}
          returnKeyType="next"
          onSubmitEditing={() => form.setFocus(path('city'))}
        />
      </FormFieldAnchor>
      <FormFieldAnchor name="city" registerFieldOffset={registerFieldOffset}>
        <Input<T>
          name={path('city')}
          control={control}
          label="City / Town (optional)"
          disabled={disabled}
          returnKeyType="next"
          onSubmitEditing={() => form.setFocus(path('district'))}
        />
      </FormFieldAnchor>
      <FormFieldAnchor name="district" registerFieldOffset={registerFieldOffset}>
        <Input<T>
          name={path('district')}
          control={control}
          label="District (optional)"
          disabled={disabled}
          returnKeyType="next"
          // Skip the State dropdown in the keyboard chain (it's tapped, not typed).
          onSubmitEditing={() => form.setFocus(path('pinCode'))}
        />
      </FormFieldAnchor>
      <FormFieldAnchor name="state" registerFieldOffset={registerFieldOffset}>
        <Controller
          name={path('state')}
          control={control}
          render={({ field: { value, onChange }, fieldState }) => (
            <StateSelect
              value={value as string | undefined}
              onChange={onChange}
              disabled={disabled}
              errorMessage={fieldState.error?.message}
            />
          )}
        />
      </FormFieldAnchor>
      <FormFieldAnchor name="pinCode" registerFieldOffset={registerFieldOffset}>
        <Input<T>
          name={path('pinCode')}
          control={control}
          label="PIN code (optional)"
          keyboardType="number-pad"
          disabled={disabled}
          returnKeyType={onPinSubmit ? 'next' : 'done'}
          onSubmitEditing={() => onPinSubmit?.()}
        />
      </FormFieldAnchor>
    </>
  );
}
