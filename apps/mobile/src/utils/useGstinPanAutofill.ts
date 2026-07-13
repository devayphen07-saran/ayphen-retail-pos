import { useEffect } from 'react';
import {
  useWatch,
  type FieldValues,
  type Path,
  type PathValue,
  type UseFormReturn,
} from 'react-hook-form';

const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

/**
 * BR-CUS-043 / BR-SUP-014 — when a valid 15-char GSTIN is entered and the PAN
 * field is still empty, auto-fill PAN from GSTIN characters 3–12. Never
 * overwrites a PAN the user already typed. Scoped `useWatch` (forms-agent §14),
 * so only the field group re-renders, not the whole form.
 */
export function useGstinPanAutofill<T extends FieldValues>(
  form: UseFormReturn<T>,
  gstinField: Path<T>,
  panField: Path<T>,
): void {
  const gstin = useWatch({ control: form.control, name: gstinField }) as
    | string
    | undefined;

  useEffect(() => {
    const value = (gstin ?? '').trim().toUpperCase();
    if (!GSTIN_RE.test(value)) return;

    const currentPan = String(form.getValues(panField) ?? '').trim();
    if (currentPan.length > 0) return;

    form.setValue(panField, value.slice(2, 12) as PathValue<T, Path<T>>, {
      shouldDirty: true,
      shouldValidate: true,
    });
  }, [gstin, form, panField]);
}
