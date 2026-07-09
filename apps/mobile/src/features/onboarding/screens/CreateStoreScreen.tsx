import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import styled from 'styled-components/native';
import { router, useNavigation } from 'expo-router';
import {
  Controller,
  useFieldArray,
  useForm,
  useWatch,
  type FieldErrors,
} from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMobileTheme } from '@ayphen/mobile-theme';
import {
  Alert,
  Column,
  DateTimeField,
  Input,
  LucideIcon,
  RadioGroup,
  Row,
  Switch,
  TextArea,
  TimeField,
  Typography,
} from '@ayphen/mobile-ui-components';
import {
  useCreateStoreMutation,
  useCurrenciesQuery,
  useGlobalLookupQuery,
  useStatesQuery,
} from '@ayphen/api-manager';
import {
  createStoreSchema,
  DEFAULT_CREATE_STORE_VALUES,
  toCreateStorePayload,
  BUSINESS_CATEGORY_TYPE,
  BusinessTypeSelect,
  StateSelect,
  CurrencySelect,
  type CreateStoreForm,
} from '@features/store';
import { handleFormError } from '../../../utils/handleFormError';
import { onValidationError } from '../../../utils/onValidationError';
import { setLastOpenedStoreId } from '@features/store/shared/utils/prefs';
import { useAuth } from '@core/providers/AuthProvider';
import { useAuthStore } from '@store';

const STEP_META = [
  {
    question: "What's your store called?",
    subtitle: 'Give your business an identity — you can always change these later.',
  },
  {
    question: 'How can customers reach you?',
    subtitle: 'Add contact details so customers and staff can reach your store.',
  },
  {
    question: 'Where is your store located?',
    subtitle: 'Used on invoices and for delivery zone calculations.',
  },
  {
    question: 'Any tax or legal details?',
    subtitle: 'All optional — you can add these later in store settings.',
  },
  {
    question: 'When are you open?',
    subtitle: "Set your store's operating hours for each day of the week.",
  },
] as const;

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_SHORT_NAMES = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

// Maps a top-level form field back to the wizard step it's shown on, so a
// submit-time validation failure (which validates the FULL schema, unlike the
// per-step `trigger()` calls) can jump the user to the offending step instead
// of failing invisibly on step 5 (see `handleWizardValidationError`).
const FIELD_STEP: Record<string, number> = {
  name: 1,
  category: 1,
  description: 1,
  phone: 2,
  email: 2,
  website: 2,
  line1: 3,
  line2: 3,
  city: 3,
  state: 3,
  pincode: 3,
  currency: 4,
  gstin: 4,
  gstRegistrationType: 4,
  pan: 4,
  businessRegNumber: 4,
  migrationDate: 4,
  makeDefault: 4,
  openingHours: 5,
};

const FIELD_LABEL: Record<string, string> = {
  name: 'Store name',
  category: 'Business category',
  description: 'Description',
  phone: 'Store phone',
  email: 'Store email',
  website: 'Website',
  line1: 'Address line 1',
  line2: 'Address line 2',
  city: 'City',
  state: 'State',
  pincode: 'PIN code',
  currency: 'Currency',
  gstin: 'GSTIN',
  gstRegistrationType: 'GST registration type',
  pan: 'PAN',
  businessRegNumber: 'Business registration number',
  migrationDate: 'Migration date',
  makeDefault: 'Default store',
  openingHours: 'Opening hours',
};

/**
 * Reached from the Onboarding Hub's "Create your store" CTA — always
 * available, regardless of pending invitations.
 *
 * Hand-rolls the five sections instead of `FormScreen` (forms-agent.md §11)
 * because this is a 5-step wizard with step-gated `trigger()` validation and
 * a custom progress-bar/step chrome — behavior `FormScreen`'s single-screen
 * wrapper doesn't cover. Field behavior (mode/reValidateMode/defaultValues,
 * dirtyFields-based unsaved guard, keyboard chaining, scroll-safe padding)
 * still follows the same rules `FormScreen` enforces elsewhere.
 */
export function CreateStoreScreen() {
  const { theme } = useMobileTheme();
  const { isAuthenticated, refetchUser } = useAuth();
  const createStore = useCreateStoreMutation();
  const navigation = useNavigation();
  const [step, setStep] = useState(1);
  // Set when final-submit validation (which spans all 5 steps, unlike the
  // per-step `trigger()` calls) fails on a field that isn't on the current
  // step — see `handleWizardValidationError`. Cleared on any step change.
  const [validationBanner, setValidationBanner] = useState<string | null>(null);

  // Fire all dropdown lookups as soon as the form opens instead of lazily per
  // step — the Select components below share these query keys via React
  // Query's cache, so by the time the user reaches step 1/3/4 the options are
  // already loaded instead of showing a spinner.
  useGlobalLookupQuery(BUSINESS_CATEGORY_TYPE, { enabled: isAuthenticated });
  useStatesQuery({ enabled: isAuthenticated });
  useCurrenciesQuery({ enabled: isAuthenticated });

  const {
    control,
    handleSubmit,
    setError,
    setValue,
    setFocus,
    trigger,
    reset,
    formState: { isSubmitting, dirtyFields },
  } = useForm<CreateStoreForm>({
    resolver: zodResolver(createStoreSchema),
    // onBlur: a field validates when the user leaves it, so an untouched
    // form never shows a red error on mount (forms-agent.md §4).
    mode: 'onBlur',
    reValidateMode: 'onChange',
    defaultValues: DEFAULT_CREATE_STORE_VALUES,
  });

  const { fields: openingHourFields } = useFieldArray({ control, name: 'openingHours' });
  // Scoped subscriptions — useWatch re-renders only on these fields, not the
  // whole form on every keystroke (forms-agent.md §8/§14).
  const gstin = (useWatch({ control, name: 'gstin' }) ?? '').trim();

  // Most stores keep one set of hours across the days they're open — default
  // to a single Open/Close pair + day picker instead of 7 separate rows, with
  // an escape hatch to the full per-day editor for stores that need it.
  const [sameHoursEveryDay, setSameHoursEveryDay] = useState(true);
  const masterOpenTime = useWatch({ control, name: 'openingHours.0.openTime' });
  const masterCloseTime = useWatch({ control, name: 'openingHours.0.closeTime' });

  useEffect(() => {
    if (!sameHoursEveryDay) return;
    // Cascade must mark the mirrored days dirty AND validated/touched, or the
    // form stays unaware of the auto-filled values (forms-agent.md §8).
    const opts = { shouldDirty: true, shouldValidate: true, shouldTouch: true } as const;
    for (let i = 1; i < 7; i++) {
      setValue(`openingHours.${i}.openTime`, masterOpenTime, opts);
      setValue(`openingHours.${i}.closeTime`, masterCloseTime, opts);
    }
  }, [sameHoursEveryDay, masterOpenTime, masterCloseTime, setValue]);

  const onSubmit = async (values: CreateStoreForm) => {
    try {
      const res = await createStore.mutateAsync({
        bodyParam: toCreateStorePayload(values),
      });
      await setLastOpenedStoreId(res.id);
      // Store creation bumps permissionsVersion server-side (H-6) and the
      // response now embeds the refreshed snapshot directly — patch it in
      // place instead of a full bootstrap round trip, or the gate would
      // bounce back here (empty stores[]) before the gate re-evaluates.
      // Falls back to refetchUser() if the backend's best-effort embed came
      // back null (rare).
      if (res.snapshot && res.snapshot_signature) {
        useAuthStore.getState().setSnapshot(res.snapshot, res.snapshot_signature);
      } else {
        await refetchUser();
      }
      // Clean baseline before navigating away — matches every other
      // FormScreen/auth-screen success path (forms-agent.md §6); this screen
      // unmounts on replace so the practical effect is nil, but leaving it out
      // is the one success path in the app that silently deviated from the
      // pattern (also true if the mutation succeeds and refetch is retried).
      reset();
      // Success is not user intent to abandon the form — bypass the
      // unsaved-changes guard below so `router.replace` isn't intercepted.
      bypassGuardRef.current = true;
      router.replace('/(app)');
    } catch (err) {
      handleFormError(err, setError, 'Could not create the store.');
    }
  };

  const handleNextStep1 = async () => {
    setValidationBanner(null);
    if (await trigger(['name', 'category'])) setStep(2);
  };
  const handleNextStep2 = async () => {
    setValidationBanner(null);
    if (await trigger(['phone', 'email', 'website'])) setStep(3);
  };
  const handleNextStep3 = async () => {
    setValidationBanner(null);
    if (await trigger(['line1', 'line2', 'city', 'state', 'pincode'])) setStep(4);
  };
  const handleNextStep4 = async () => {
    setValidationBanner(null);
    if (await trigger(['currency', 'gstin', 'gstRegistrationType', 'pan', 'businessRegNumber'])) {
      setStep(5);
    }
  };

  // Final submit validates the FULL schema across all 5 steps — unlike the
  // per-step `trigger()` calls above, a cross-step rule can fail on a field
  // that isn't on the visible step. Jump to that step and name the field
  // instead of letting `onValidationError`'s silent log-and-return be the
  // only feedback (previously: tapping "Create Store" could appear to do
  // nothing at all).
  const handleWizardValidationError = (errors: FieldErrors<CreateStoreForm>) => {
    onValidationError(errors);
    const firstField = Object.keys(errors)[0];
    if (!firstField) return;
    const targetStep = FIELD_STEP[firstField] ?? step;
    const label = FIELD_LABEL[firstField] ?? firstField;
    setValidationBanner(`Please check ${label} — step ${targetStep} of ${STEP_META.length}.`);
    if (targetStep !== step) setStep(targetStep);
  };
  const handleNextStep5 = handleSubmit(onSubmit, handleWizardValidationError);

  const NEXT_HANDLERS = [
    handleNextStep1,
    handleNextStep2,
    handleNextStep3,
    handleNextStep4,
    handleNextStep5,
  ] as const;

  const handleNext = NEXT_HANDLERS[step - 1];
  const handleBack = () => {
    setValidationBanner(null);
    setStep((s) => s - 1);
  };
  const isLastStep = step === 5;
  const hasUnsavedChanges = Object.keys(dirtyFields).length > 0;

  // Guards EVERY exit vector — iOS swipe-back and Android hardware back
  // previously exited this 5-step form with zero confirmation; only the
  // in-screen "X" (handleClose, below) was guarded. Mirrors FormScreen's
  // `beforeRemove` pattern (forms-agent.md §5/§13.7).
  const dirtyRef = useRef(hasUnsavedChanges);
  dirtyRef.current = hasUnsavedChanges;
  const bypassGuardRef = useRef(false);

  useEffect(() => {
    const sub = navigation.addListener('beforeRemove', (e) => {
      if (bypassGuardRef.current || !dirtyRef.current) return;
      e.preventDefault();
      Alert.show('Discard store setup?', 'Your progress will be lost.', [
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

  // Closing a partially-filled wizard is destructive — confirm before discarding
  // (forms-agent.md §5/§13.7). Nothing entered → close straight away.
  const handleClose = () => {
    if (!hasUnsavedChanges) {
      router.back();
      return;
    }
    Alert.show('Discard store setup?', 'Your progress will be lost.', [
      { text: 'Keep editing', style: 'cancel' },
      {
        text: 'Discard',
        style: 'destructive',
        onPress: () => {
          // This IS the confirmation the beforeRemove guard above would
          // otherwise show again on the `router.back()` it triggers.
          bypassGuardRef.current = true;
          reset();
          router.back();
        },
      },
    ]);
  };

  return (
    <Root edges={['top', 'bottom']}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <Row
          align="center"
          justify="space-between"
          style={{
            paddingLeft: theme.sizing.large,
            paddingRight: theme.sizing.regular,
            paddingTop: theme.sizing.xSmall,
          }}
        >
          <Typography.Caption weight="semiBold" color={theme.colorTextSecondary}>
            Set up your store
          </Typography.Caption>
          <CloseButton onPress={handleClose} disabled={isSubmitting} activeOpacity={0.7}>
            <LucideIcon name="X" size={15} color={theme.colorTextSecondary} />
          </CloseButton>
        </Row>

        <ProgressTrack>
          {STEP_META.map((_, i) => (
            <ProgressSegment key={i} $filled={i + 1 <= step} />
          ))}
        </ProgressTrack>

        <ScrollView
          contentContainerStyle={{
            paddingHorizontal: theme.sizing.large,
            paddingTop: theme.sizing.large,
            paddingBottom: 80,
          }}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          showsVerticalScrollIndicator={false}
        >
          <Typography.Caption
            weight={700}
            color={theme.colorPrimary}
            style={{ letterSpacing: 1.2, textTransform: 'uppercase', marginBottom: 14 }}
          >
            Step {step} of {STEP_META.length}
          </Typography.Caption>
          <Typography.H1 color={theme.colorText} style={{ marginBottom: 8 }}>
            {STEP_META[step - 1].question}
          </Typography.H1>
          <Typography.Body color={theme.colorTextSecondary} style={{ marginBottom: 28 }}>
            {STEP_META[step - 1].subtitle}
          </Typography.Body>

          {validationBanner ? (
            <ValidationBanner>
              <LucideIcon name="AlertCircle" size={16} color={theme.colorWarning} />
              <Typography.Caption color={theme.colorWarning} style={{ flex: 1 }}>
                {validationBanner}
              </Typography.Caption>
            </ValidationBanner>
          ) : null}

          {/* ─── Step 1: Identity ─── */}
          {step === 1 && (
            <Column gap={theme.sizing.medium}>
              <Input<CreateStoreForm>
                name="name"
                control={control}
                label="Store name"
                placeholder="e.g. Sunrise Provisions"
                required
                autoFocus
                disabled={isSubmitting}
                prefix={<LucideIcon name="Store" size={16} color={theme.colorTextTertiary} />}
                returnKeyType="next"
                onSubmitEditing={() => setFocus('description')}
              />
              <Controller
                name="category"
                control={control}
                render={({ field: { value, onChange }, fieldState }) => (
                  <BusinessTypeSelect
                    value={value || undefined}
                    onChange={(code) => onChange(code ?? '')}
                    disabled={isSubmitting}
                    errorMessage={fieldState.error?.message}
                  />
                )}
              />
              <TextArea<CreateStoreForm>
                name="description"
                control={control}
                label="Description / tagline (optional)"
                placeholder="e.g. Fresh groceries delivered to your door"
                disabled={isSubmitting}
                returnKeyType="done"
                onSubmitEditing={handleNextStep1}
              />
            </Column>
          )}

          {/* ─── Step 2: Contact ─── */}
          {step === 2 && (
            <Column gap={theme.sizing.medium}>
              <Input<CreateStoreForm>
                name="phone"
                control={control}
                label="Store phone (optional)"
                placeholder="e.g. +91 98765 43210"
                inputDataType="phoneNumber"
                maxLength={20}
                disabled={isSubmitting}
                prefix={<LucideIcon name="Phone" size={16} color={theme.colorTextTertiary} />}
                returnKeyType="next"
                onSubmitEditing={() => setFocus('email')}
              />
              <Input<CreateStoreForm>
                name="email"
                control={control}
                label="Store email (optional)"
                placeholder="e.g. hello@mystore.com"
                inputDataType="email"
                disabled={isSubmitting}
                prefix={<LucideIcon name="Mail" size={16} color={theme.colorTextTertiary} />}
                returnKeyType="next"
                onSubmitEditing={() => setFocus('website')}
              />
              <Input<CreateStoreForm>
                name="website"
                control={control}
                label="Website / social link (optional)"
                placeholder="e.g. https://mystore.com"
                keyboardType="url"
                autoCapitalize="none"
                disabled={isSubmitting}
                prefix={<LucideIcon name="Globe" size={16} color={theme.colorTextTertiary} />}
                returnKeyType="done"
                onSubmitEditing={handleNextStep2}
              />
            </Column>
          )}

          {/* ─── Step 3: Location ─── */}
          {step === 3 && (
            <Column gap={theme.sizing.medium}>
              <Input<CreateStoreForm>
                name="line1"
                control={control}
                label="Address line 1 (optional)"
                placeholder="Shop no., building, street"
                disabled={isSubmitting}
                prefix={<LucideIcon name="MapPin" size={16} color={theme.colorTextTertiary} />}
                returnKeyType="next"
                onSubmitEditing={() => setFocus('line2')}
              />
              <Input<CreateStoreForm>
                name="line2"
                control={control}
                label="Address line 2 (optional)"
                placeholder="Area, landmark"
                disabled={isSubmitting}
                returnKeyType="next"
                onSubmitEditing={() => setFocus('city')}
              />
              <Input<CreateStoreForm>
                name="city"
                control={control}
                label="City (optional)"
                placeholder="e.g. Coimbatore"
                disabled={isSubmitting}
                returnKeyType="next"
                onSubmitEditing={() => setFocus('pincode')}
              />
              <Controller
                name="state"
                control={control}
                render={({ field: { value, onChange }, fieldState }) => (
                  <StateSelect
                    value={value || undefined}
                    onChange={(code) => onChange(code ?? '')}
                    disabled={isSubmitting}
                    errorMessage={fieldState.error?.message}
                  />
                )}
              />
              <Input<CreateStoreForm>
                name="pincode"
                control={control}
                label="PIN code (optional)"
                placeholder="6-digit PIN"
                inputDataType="integer"
                maxLength={6}
                disabled={isSubmitting}
                returnKeyType="done"
                onSubmitEditing={handleNextStep3}
              />
            </Column>
          )}

          {/* ─── Step 4: Tax & Legal ─── */}
          {step === 4 && (
            <Column gap={theme.sizing.medium}>
              <Controller
                name="currency"
                control={control}
                render={({ field: { value, onChange }, fieldState }) => (
                  <CurrencySelect
                    value={value || undefined}
                    onChange={(code) => onChange(code ?? '')}
                    disabled
                    errorMessage={fieldState.error?.message}
                  />
                )}
              />
              <Input<CreateStoreForm>
                name="gstin"
                control={control}
                label="GSTIN (optional)"
                placeholder="15-character GST number"
                autoCapitalize="characters"
                maxLength={15}
                disabled={isSubmitting}
                prefix={<LucideIcon name="ReceiptText" size={16} color={theme.colorTextTertiary} />}
                returnKeyType="next"
                onSubmitEditing={() => setFocus('pan')}
              />
              {gstin ? (
                <Controller
                  name="gstRegistrationType"
                  control={control}
                  render={({ field: { value, onChange }, fieldState }) => (
                    <RadioGroup
                      label="Registration type"
                      options={[
                        { label: 'Regular GST', value: 'regular' },
                        { label: 'Composition scheme', value: 'composition' },
                      ]}
                      value={value || undefined}
                      onChange={onChange}
                      disabled={isSubmitting}
                      errorMessage={fieldState.error?.message}
                    />
                  )}
                />
              ) : null}
              <Input<CreateStoreForm>
                name="pan"
                control={control}
                label="PAN (optional)"
                placeholder="e.g. ABCDE1234F"
                autoCapitalize="characters"
                maxLength={10}
                disabled={isSubmitting}
                prefix={<LucideIcon name="CreditCard" size={16} color={theme.colorTextTertiary} />}
                returnKeyType="next"
                onSubmitEditing={() => setFocus('businessRegNumber')}
              />
              <Input<CreateStoreForm>
                name="businessRegNumber"
                control={control}
                label="Business registration number (optional)"
                placeholder="e.g. MSME/Udyam, FSSAI, Shop Est. no."
                disabled={isSubmitting}
                prefix={<LucideIcon name="FileText" size={16} color={theme.colorTextTertiary} />}
                returnKeyType="done"
                onSubmitEditing={handleNextStep4}
              />
              <DateTimeField<CreateStoreForm>
                name="migrationDate"
                control={control}
                label="Migration date (optional)"
                placeholder="Today (default)"
                maximumDate={new Date()}
                disabled={isSubmitting}
              />
              <ToggleRow>
                <Column flex={1}>
                  <Typography.Body weight="semiBold">
                    Make this my default store
                  </Typography.Body>
                  <Typography.Caption color={theme.colorTextSecondary}>
                    Opens automatically the next time you launch the app.
                  </Typography.Caption>
                </Column>
                <Switch name="makeDefault" control={control} disabled={isSubmitting} />
              </ToggleRow>
            </Column>
          )}

          {/* ─── Step 5: Opening Hours ─── */}
          {step === 5 && (
            <Column gap={theme.sizing.medium}>
              <ToggleRow>
                <Column flex={1}>
                  <Typography.Body weight="semiBold">
                    Same hours every day
                  </Typography.Body>
                  <Typography.Caption color={theme.colorTextSecondary}>
                    One opening time for every day you're open
                  </Typography.Caption>
                </Column>
                <Switch
                  checked={sameHoursEveryDay}
                  onValueChange={setSameHoursEveryDay}
                  disabled={isSubmitting}
                />
              </ToggleRow>

              {sameHoursEveryDay ? (
                <>
                  <Row
                    gap={theme.sizing.xSmall}
                    flex={1}
                    style={{ marginHorizontal: theme.sizing.xSmall }}
                  >
                    <TimeField<CreateStoreForm>
                      name="openingHours.0.openTime"
                      control={control}
                      placeholder="Open"
                      disabled={isSubmitting}
                    />
                    <TimeField<CreateStoreForm>
                      name="openingHours.0.closeTime"
                      control={control}
                      placeholder="Close"
                      disabled={isSubmitting}
                    />
                  </Row>

                  <Typography.Caption color={theme.colorTextSecondary}>
                    Open on
                  </Typography.Caption>
                  <Row wrap="wrap" gap={theme.sizing.xSmall}>
                    {openingHourFields.map((field, index) => (
                      <Controller
                        key={field.id}
                        control={control}
                        name={`openingHours.${index}.isClosed`}
                        render={({ field: { value, onChange } }) => (
                          <DayChip
                            $active={!value}
                            onPress={() => onChange(!value)}
                            disabled={isSubmitting}
                            activeOpacity={0.7}
                            accessibilityRole="button"
                            accessibilityLabel={DAY_NAMES[field.dayOfWeek]}
                            accessibilityState={{ selected: !value }}
                          >
                            <DayChipText $active={!value}>
                              {DAY_SHORT_NAMES[field.dayOfWeek]}
                            </DayChipText>
                          </DayChip>
                        )}
                      />
                    ))}
                  </Row>
                </>
              ) : (
                openingHourFields.map((field, index) => (
                  // A single Controller both reads isClosed (for the conditional)
                  // and drives the Switch — no top-level watch() (§14).
                  <Controller
                    key={field.id}
                    control={control}
                    name={`openingHours.${index}.isClosed`}
                    render={({ field: { value: isClosed, onChange } }) => (
                      <DayRow>
                        <Typography.Body weight={600} style={{ width: 90 }}>
                          {DAY_NAMES[field.dayOfWeek]}
                        </Typography.Body>

                        {!isClosed ? (
                          <Row
                            gap={theme.sizing.xSmall}
                            flex={1}
                            style={{ marginHorizontal: theme.sizing.xSmall }}
                          >
                            <TimeField<CreateStoreForm>
                              name={`openingHours.${index}.openTime`}
                              control={control}
                              placeholder="Open"
                              disabled={isSubmitting}
                            />
                            <TimeField<CreateStoreForm>
                              name={`openingHours.${index}.closeTime`}
                              control={control}
                              placeholder="Close"
                              disabled={isSubmitting}
                            />
                          </Row>
                        ) : (
                          <Typography.Caption
                            color={theme.colorTextSecondary}
                            style={{ flex: 1, marginHorizontal: theme.sizing.xSmall }}
                          >
                            Closed
                          </Typography.Caption>
                        )}

                        <Switch
                          checked={!isClosed}
                          onValueChange={(isOpen) => onChange(!isOpen)}
                          disabled={isSubmitting}
                        />
                      </DayRow>
                    )}
                  />
                ))
              )}
            </Column>
          )}
        </ScrollView>

        <NavBar>
          {step > 1 ? (
            <BackSquare onPress={handleBack} disabled={isSubmitting} activeOpacity={0.7}>
              <LucideIcon name="ArrowLeft" size={18} color={theme.colorText} />
            </BackSquare>
          ) : (
            <Column width={52} />
          )}
          <NextPill
            onPress={handleNext}
            disabled={isSubmitting || (isLastStep && !hasUnsavedChanges)}
            activeOpacity={0.85}
          >
            {isSubmitting && isLastStep ? (
              <ActivityIndicator size="small" color={theme.colorBgContainer} />
            ) : isLastStep ? (
              <>
                <Typography.Body
                  weight={600}
                  color={theme.colorBgContainer}
                  style={{ letterSpacing: 0.2 }}
                >
                  Create Store
                </Typography.Body>
                <LucideIcon name="Check" size={15} color={theme.colorBgContainer} />
              </>
            ) : (
              <>
                <Typography.Body
                  weight={600}
                  color={theme.colorBgContainer}
                  style={{ letterSpacing: 0.2 }}
                >
                  Next
                </Typography.Body>
                <LucideIcon name="ArrowRight" size={15} color={theme.colorBgContainer} />
              </>
            )}
          </NextPill>
        </NavBar>
      </KeyboardAvoidingView>
    </Root>
  );
}

// ─── Styled components ────────────────────────────────────────────────────────

const Root = styled(SafeAreaView)`
  flex: 1;
  background-color: ${({ theme }) => theme.colorBgContainer};
`;

const CloseButton = styled(TouchableOpacity)`
  width: 32px;
  height: 32px;
  border-radius: ${({ theme }) => theme.borderRadius.full}px;
  background-color: ${({ theme }) => theme.colorBgLayout};
  align-items: center;
  justify-content: center;
`;

const ValidationBanner = styled(Row)`
  align-items: center;
  gap: ${({ theme }) => theme.sizing.xSmall}px;
  padding: ${({ theme }) => theme.sizing.small}px ${({ theme }) => theme.sizing.regular}px;
  border-radius: ${({ theme }) => theme.borderRadius.large}px;
  background-color: ${({ theme }) => theme.colorWarningBg};
  margin-bottom: ${({ theme }) => theme.sizing.medium}px;
`;

const ProgressTrack = styled(View)`
  flex-direction: row;
  gap: 5px;
  padding-left: ${({ theme }) => theme.sizing.large}px;
  padding-right: ${({ theme }) => theme.sizing.large}px;
  padding-top: ${({ theme }) => theme.sizing.small}px;
`;

const ProgressSegment = styled(View)<{ $filled: boolean }>`
  flex: 1;
  height: 4px;
  border-radius: ${({ theme }) => theme.borderRadius.full}px;
  background-color: ${({ theme, $filled }) => ($filled ? theme.colorPrimary : theme.colorBorderSecondary)};
`;

const NavBar = styled(View)`
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  padding-left: ${({ theme }) => theme.sizing.large}px;
  padding-right: ${({ theme }) => theme.sizing.large}px;
  padding-top: 14px;
  padding-bottom: ${({ theme }) => theme.sizing.large}px;
  background-color: ${({ theme }) => theme.colorBgContainer};
  border-top-width: ${({ theme }) => theme.borderWidth.thin}px;
  border-top-color: ${({ theme }) => theme.colorBorderSecondary};
`;

const BackSquare = styled(TouchableOpacity)`
  width: 52px;
  height: 52px;
  border-radius: ${({ theme }) => theme.borderRadius.xxLarge}px;
  background-color: ${({ theme }) => theme.colorBgContainer};
  border-width: ${({ theme }) => theme.borderWidth.light}px;
  border-color: ${({ theme }) => theme.colorBorder};
  align-items: center;
  justify-content: center;
`;

const NextPill = styled(TouchableOpacity)`
  flex-direction: row;
  align-items: center;
  justify-content: center;
  gap: 6px;
  background-color: ${({ theme }) => theme.colorPrimary};
  border-radius: 100px;
  padding-left: 22px;
  padding-right: 18px;
  padding-top: 14px;
  padding-bottom: 14px;
  min-width: 110px;
`;

const ToggleRow = styled(View)`
  flex-direction: row;
  align-items: center;
  gap: ${({ theme }) => theme.sizing.regular}px;
  margin-top: ${({ theme }) => theme.sizing.small}px;
  padding: ${({ theme }) => theme.sizing.regular}px;
  border-radius: ${({ theme }) => theme.borderRadius.xLarge}px;
  border-width: ${({ theme }) => theme.borderWidth.thin}px;
  border-color: ${({ theme }) => theme.colorBorderSecondary};
`;

const DayRow = styled(View)`
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  padding: ${({ theme }) => theme.sizing.small}px;
  border-radius: ${({ theme }) => theme.borderRadius.large}px;
  border-width: ${({ theme }) => theme.borderWidth.thin}px;
  border-color: ${({ theme }) => theme.colorBorderSecondary};
`;

const DayChip = styled(TouchableOpacity)<{ $active: boolean }>`
  width: 44px;
  height: 44px;
  border-radius: 22px;
  align-items: center;
  justify-content: center;
  background-color: ${({ $active, theme }) => ($active ? theme.color.primary.bg : theme.colorBgLayout)};
  border-width: ${({ theme }) => theme.borderWidth.light}px;
  border-color: ${({ $active, theme }) => ($active ? theme.colorPrimary : theme.colorBorder)};
`;

const DayChipText = styled(Typography.Caption)<{ $active: boolean }>`
  font-weight: 700;
  color: ${({ $active, theme }) => ($active ? theme.colorPrimary : theme.colorTextTertiary)};
`;
