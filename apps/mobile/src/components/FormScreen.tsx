import React, { ReactNode, useCallback, useEffect, useRef } from 'react';
import { ScrollView, View } from 'react-native';
import {
  useForm,
  FormProvider,
  type Control,
  type FieldErrors,
  type DefaultValues,
  type FieldValues,
  type Resolver,
  type SubmitHandler,
  type UseFormReturn,
  type UseFormSetError,
} from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { ZodType } from 'zod';
import { useNavigation } from 'expo-router';
import { useMobileTheme } from '@ayphen/mobile-theme';
import { AppLayout, Alert, Button, Column } from '@ayphen/mobile-ui-components';
import { handleFormError } from '../utils/handleFormError';
import { onValidationError } from '../utils/onValidationError';

/**
 * FormScreen — the canonical wrapper every store/onboarding form uses
 * (forms-agent.md §11). It owns the parts that ad-hoc forms kept getting wrong,
 * so a bug fixed here is fixed everywhere:
 *
 *  - `useForm` with the REQUIRED options (mode:'onBlur' + reValidateMode:'onChange'
 *    + explicit defaultValues) — without these RHF's defaults are wrong for this UX.
 *  - `FormProvider` so deep fields can `useFormContext()` (§7).
 *  - Header + scroll view with the correct keyboard config
 *    (`keyboardShouldPersistTaps` / `keyboardDismissMode` / `paddingBottom ≥ 80`, §7).
 *  - A submit button gated EXACTLY on `!hasUnsavedChanges || isSubmitting` with a
 *    spinner — no empty-form saves, no double-submits (§7/§13.2). Never gated on `isValid`.
 *  - The unsaved-changes guard on EVERY back vector — header back, iOS swipe, and
 *    Android hardware back — via `beforeRemove` (§5/§13.7), with Discard as the
 *    explicit destructive action.
 *  - Centralized error mapping: a feature-supplied `mapError` for domain codes,
 *    then the shared `handleFormError` precedence (§6). No silent failures.
 *  - Create vs edit is DERIVED from `isEdit`: edit sends only `dirtyFields` (PATCH),
 *    re-baselines with `reset(values)`, and closes silently when nothing changed;
 *    create sends the full object and `reset()`s (§11A).
 *
 * The feature only says WHAT to dispatch (`onSubmit`), where to go on success
 * (`onSuccess`, default = back), and how to map its own server error codes
 * (`mapError`). Everything else is shared.
 */

export interface FormScreenChildApi<T extends FieldValues> {
  control: Control<T>;
  form: UseFormReturn<T>;
  isSubmitting: boolean;
  /**
   * Wire onto the LAST text input:
   * `returnKeyType="done"` + `onSubmitEditing={submitOnLast}`.
   * Middle inputs use `returnKeyType="next"` + `onSubmitEditing={() => form.setFocus('next')}`.
   */
  submitOnLast: () => void;
  /**
   * Wrap a field with `<FormFieldAnchor name="fieldName" registerFieldOffset={registerFieldOffset}>`
   * so a submit-time validation failure can scroll to it (forms-agent.md §13.4)
   * — RHF's own `shouldFocusError` already calls `.focus()` on the first
   * errored field, but a plain RN `ScrollView` doesn't auto-scroll a focused
   * input into view the way a browser does, so without this a focused-but-
   * off-screen field is invisible feedback.
   */
  registerFieldOffset: (name: string, y: number) => void;
}

/** See `FormScreenChildApi.registerFieldOffset`. Purely a layout-measurement
 *  wrapper — renders its child with no visual effect. */
export function FormFieldAnchor({
  name,
  registerFieldOffset,
  children,
}: {
  name: string;
  registerFieldOffset: (name: string, y: number) => void;
  children: ReactNode;
}) {
  return (
    <View onLayout={(e) => registerFieldOffset(name, e.nativeEvent.layout.y)}>
      {children}
    </View>
  );
}

export interface FormSubmitContext<T extends FieldValues> {
  isEdit: boolean;
  /** Only the keys the user changed — edit forms PATCH exactly these (§6/§11A). */
  dirtyFields: Partial<Record<keyof T, unknown>>;
  form: UseFormReturn<T>;
  setError: UseFormSetError<T>;
}

export interface FormScreenProps<T extends FieldValues> {
  schema: ZodType<T>;
  defaultValues: DefaultValues<T>;
  /** true ⇒ edit mode (PATCH only dirty keys, `reset(values)`, silent close if unchanged). */
  isEdit?: boolean;
  title: string;
  submitLabel: string;
  /** Dispatch the mutation ONLY — do not navigate here. Throw to surface an error. */
  onSubmit: (values: T, ctx: FormSubmitContext<T>) => Promise<void>;
  /** Navigate after a successful submit (form already reset). Default: go back. */
  onSuccess?: (values: T) => void;
  /**
   * Map a domain-specific server error to a field (via `setError`) before the
   * generic handler runs. Return true if you handled it.
   */
  mapError?: (err: unknown, setError: UseFormSetError<T>) => boolean;
  fallbackError?: string;
  /** Extra gate ANDed with the built-in `!hasUnsavedChanges || isSubmitting`. */
  submitDisabled?: boolean;
  /** Show the header's indeterminate progress bar. */
  loading?: boolean;
  headerRight?: ReactNode;
  children: (api: FormScreenChildApi<T>) => ReactNode;
}

export function FormScreen<T extends FieldValues>({
  schema,
  defaultValues,
  isEdit = false,
  title,
  submitLabel,
  onSubmit,
  onSuccess,
  mapError,
  fallbackError,
  submitDisabled = false,
  loading = false,
  headerRight,
  children,
}: FormScreenProps<T>) {
  const { theme } = useMobileTheme();
  const navigation = useNavigation();

  const form = useForm<T>({
    // A generic ZodType<T> can't be matched to zodResolver's overloads or proven
    // to produce a Resolver<T> statically (its input type is `unknown`), so pin
    // both ends — the runtime resolver is correct; only the static shape needs help.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resolver: zodResolver(schema as any) as unknown as Resolver<T>,
    mode: 'onBlur',
    reValidateMode: 'onChange',
    defaultValues,
  });
  const {
    control,
    handleSubmit,
    reset,
    setError,
    formState: { isSubmitting, dirtyFields },
  } = form;
  const hasUnsavedChanges = Object.keys(dirtyFields).length > 0;

  // Refs so the beforeRemove listener reads LIVE values without re-subscribing,
  // and so programmatic post-submit navigation can bypass the discard guard.
  const dirtyRef = useRef(hasUnsavedChanges);
  dirtyRef.current = hasUnsavedChanges;
  const bypassGuardRef = useRef(false);

  // Field Y-offsets (see FormFieldAnchor) — populated as fields render, read
  // only when a submit-time validation failure needs to scroll to the first
  // errored one.
  const scrollRef = useRef<ScrollView>(null);
  const fieldOffsets = useRef<Partial<Record<string, number>>>({});
  const registerFieldOffset = useCallback((name: string, y: number) => {
    fieldOffsets.current[name] = y;
  }, []);

  // Intercept every back vector (header back, iOS swipe, Android hardware back)
  // while there are unsaved changes — Discard (destructive) / Keep editing (§5/§13.7).
  useEffect(() => {
    const sub = navigation.addListener('beforeRemove', (e) => {
      if (bypassGuardRef.current || !dirtyRef.current) return;
      e.preventDefault();
      Alert.show('Discard changes?', 'Your changes will be lost.', [
        { text: 'Keep editing', style: 'cancel' },
        {
          text: 'Discard',
          style: 'destructive',
          onPress: () => {
            bypassGuardRef.current = true;
            navigation.dispatch(e.data.action);
          },
        },
      ]);
    });
    return sub;
  }, [navigation]);

  const leave = (values: T) => {
    // Clean form before navigating so beforeRemove doesn't re-prompt and a
    // reopen starts fresh (§6). Success nav is not user intent → bypass the guard.
    bypassGuardRef.current = true;
    if (onSuccess) onSuccess(values);
    else navigation.goBack();
  };

  const internalSubmit: SubmitHandler<T> = async (values) => {
    // Edit with nothing changed → leave silently, no request (§6/§11A).
    if (isEdit && !hasUnsavedChanges) {
      leave(values);
      return;
    }
    try {
      await onSubmit(values, {
        isEdit,
        dirtyFields: dirtyFields as Partial<Record<keyof T, unknown>>,
        form,
        setError,
      });
      // Edit: bake saved values as the new baseline. Create: clear.
      reset(isEdit ? values : undefined);
      leave(values);
    } catch (err) {
      if (mapError?.(err, setError)) return;
      handleFormError(err, setError, fallbackError);
    }
  };

  // RHF's own `shouldFocusError` (default) already calls `.focus()` on the
  // first errored field via its ref, but a plain RN ScrollView doesn't
  // auto-scroll a focused input into view — so scroll explicitly to whatever
  // FormFieldAnchor recorded for it. `onValidationError` still runs first,
  // unconditionally, for the observability guarantee it already provides.
  const handleInvalid = (errors: FieldErrors<T>) => {
    onValidationError(errors);
    const firstErroredField = Object.keys(errors)[0];
    const y = firstErroredField ? fieldOffsets.current[firstErroredField] : undefined;
    if (y != null) {
      scrollRef.current?.scrollTo({ y: Math.max(y - theme.sizing.large, 0), animated: true });
    }
  };

  const submitOnLast = handleSubmit(internalSubmit, handleInvalid);
  const disabled = !hasUnsavedChanges || isSubmitting || submitDisabled;

  return (
    <FormProvider {...form}>
      <AppLayout
        title={title}
        onBack={() => navigation.goBack()}
        loading={loading}
        rightElement={headerRight}
      >
        <ScrollView
          ref={scrollRef}
          contentContainerStyle={{
            padding: theme.sizing.large,
            paddingBottom: 80,
            flexGrow: 1,
          }}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          showsVerticalScrollIndicator={false}
        >
          <Column gap={theme.sizing.medium}>
            {children({ control, form, isSubmitting, submitOnLast, registerFieldOffset })}
            <Button
              label={submitLabel}
              variant="primary"
              loading={isSubmitting}
              disabled={disabled}
              onPress={submitOnLast}
              accessibilityState={{ disabled, busy: isSubmitting }}
            />
          </Column>
        </ScrollView>
      </AppLayout>
    </FormProvider>
  );
}

export default FormScreen;
