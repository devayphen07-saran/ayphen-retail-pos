import { useEffect, useState } from 'react';
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
import { router } from 'expo-router';
import { Controller, useFieldArray, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMobileTheme } from '@ayphen/mobile-theme';
import {
  Column,
  DateTimeField,
  Input,
  LucideIcon,
  RadioGroup,
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
  type CreateStoreForm,
} from '@features/store/schema';
import { toCreateStorePayload } from '@features/store/transform';
import { BUSINESS_CATEGORY_TYPE, BusinessTypeSelect } from '@features/store/selects/BusinessTypeSelect';
import { StateSelect } from '@features/store/selects/StateSelect';
import { CurrencySelect } from '@features/store/selects/CurrencySelect';
import { handleFormError } from '../../../utils/handleFormError';
import { onValidationError } from '../../../utils/onValidationError';
import { setLastOpenedStoreId } from '@features/store/prefs';
import { useAuth } from '@core/providers/AuthProvider';

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

/** Reached from the Onboarding Hub's "Create your store" CTA — always
 *  available, regardless of pending invitations. */
export function CreateStoreScreen() {
  const { theme } = useMobileTheme();
  const { isAuthenticated, refetchUser } = useAuth();
  const createStore = useCreateStoreMutation();
  const [step, setStep] = useState(1);

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
    trigger,
    watch,
    formState: { isSubmitting },
  } = useForm<CreateStoreForm>({
    resolver: zodResolver(createStoreSchema),
    // onBlur: a field validates when the user leaves it, so an untouched
    // form never shows a red error on mount (forms-agent.md §4).
    mode: 'onBlur',
    reValidateMode: 'onChange',
    defaultValues: DEFAULT_CREATE_STORE_VALUES,
  });

  const { fields: openingHourFields } = useFieldArray({ control, name: 'openingHours' });
  const gstin = (watch('gstin') ?? '').trim();

  // Most stores keep one set of hours across the days they're open — default
  // to a single Open/Close pair + day picker instead of 7 separate rows, with
  // an escape hatch to the full per-day editor for stores that need it.
  const [sameHoursEveryDay, setSameHoursEveryDay] = useState(true);
  const masterOpenTime = watch('openingHours.0.openTime');
  const masterCloseTime = watch('openingHours.0.closeTime');

  useEffect(() => {
    if (!sameHoursEveryDay) return;
    for (let i = 1; i < 7; i++) {
      setValue(`openingHours.${i}.openTime`, masterOpenTime, { shouldDirty: true });
      setValue(`openingHours.${i}.closeTime`, masterCloseTime, { shouldDirty: true });
    }
  }, [sameHoursEveryDay, masterOpenTime, masterCloseTime, setValue]);

  const onSubmit = async (values: CreateStoreForm) => {
    try {
      const res = await createStore.mutateAsync({
        bodyParam: toCreateStorePayload(values),
      });
      await setLastOpenedStoreId(res.id);
      // Store creation bumps permissionsVersion server-side (H-6) — refetch
      // bootstrap so the snapshot reflects the new STORE_OWNER role + store
      // before the gate re-evaluates, or it'll bounce back here (empty stores[]).
      await refetchUser();
      router.replace('/(app)');
    } catch (err) {
      handleFormError(err, setError, 'Could not create the store.');
    }
  };

  const handleNextStep1 = async () => {
    if (await trigger(['name', 'category'])) setStep(2);
  };
  const handleNextStep2 = async () => {
    if (await trigger(['phone', 'email', 'website'])) setStep(3);
  };
  const handleNextStep3 = async () => {
    if (await trigger(['line1', 'line2', 'city', 'state', 'pincode'])) setStep(4);
  };
  const handleNextStep4 = async () => {
    if (await trigger(['currency', 'gstin', 'gstRegistrationType', 'pan', 'businessRegNumber'])) {
      setStep(5);
    }
  };
  const handleNextStep5 = handleSubmit(onSubmit, onValidationError);

  const NEXT_HANDLERS = [
    handleNextStep1,
    handleNextStep2,
    handleNextStep3,
    handleNextStep4,
    handleNextStep5,
  ] as const;

  const handleNext = NEXT_HANDLERS[step - 1];
  const handleBack = () => setStep((s) => s - 1);
  const isLastStep = step === 5;

  const handleClose = () => router.back();

  return (
    <Root edges={['top', 'bottom']}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <TopBar>
          <Typography.Caption weight="semiBold" color={theme.colorTextSecondary}>
            Set up your store
          </Typography.Caption>
          <CloseButton onPress={handleClose} disabled={isSubmitting} activeOpacity={0.7}>
            <LucideIcon name="X" size={15} color={theme.colorTextSecondary} />
          </CloseButton>
        </TopBar>

        <ProgressTrack>
          {STEP_META.map((_, i) => (
            <ProgressSegment key={i} $filled={i + 1 <= step} />
          ))}
        </ProgressTrack>

        <ScrollView
          contentContainerStyle={{ paddingHorizontal: 24, paddingTop: 24, paddingBottom: theme.sizing.large }}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <StepCounter>Step {step} of {STEP_META.length}</StepCounter>
          <QuestionHeading>{STEP_META[step - 1].question}</QuestionHeading>
          <QuestionSubtitle>{STEP_META[step - 1].subtitle}</QuestionSubtitle>

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
              />
              <Input<CreateStoreForm>
                name="email"
                control={control}
                label="Store email (optional)"
                placeholder="e.g. hello@mystore.com"
                inputDataType="email"
                disabled={isSubmitting}
                prefix={<LucideIcon name="Mail" size={16} color={theme.colorTextTertiary} />}
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
              />
              <Input<CreateStoreForm>
                name="line2"
                control={control}
                label="Address line 2 (optional)"
                placeholder="Area, landmark"
                disabled={isSubmitting}
              />
              <Input<CreateStoreForm>
                name="city"
                control={control}
                label="City (optional)"
                placeholder="e.g. Coimbatore"
                disabled={isSubmitting}
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
              />
              <Input<CreateStoreForm>
                name="businessRegNumber"
                control={control}
                label="Business registration number (optional)"
                placeholder="e.g. MSME/Udyam, FSSAI, Shop Est. no."
                disabled={isSubmitting}
                prefix={<LucideIcon name="FileText" size={16} color={theme.colorTextTertiary} />}
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
                <ToggleText>
                  <Typography.Body weight="semiBold">
                    Make this my default store
                  </Typography.Body>
                  <Typography.Caption color={theme.colorTextSecondary}>
                    Opens automatically the next time you launch the app.
                  </Typography.Caption>
                </ToggleText>
                <Switch name="makeDefault" control={control} disabled={isSubmitting} />
              </ToggleRow>
            </Column>
          )}

          {/* ─── Step 5: Opening Hours ─── */}
          {step === 5 && (
            <Column gap={theme.sizing.medium}>
              <ToggleRow>
                <ToggleText>
                  <Typography.Body weight="semiBold">
                    Same hours every day
                  </Typography.Body>
                  <Typography.Caption color={theme.colorTextSecondary}>
                    One opening time for every day you're open
                  </Typography.Caption>
                </ToggleText>
                <Switch
                  checked={sameHoursEveryDay}
                  onValueChange={setSameHoursEveryDay}
                  disabled={isSubmitting}
                />
              </ToggleRow>

              {sameHoursEveryDay ? (
                <>
                  <TimeGroup>
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
                  </TimeGroup>

                  <Typography.Caption color={theme.colorTextSecondary}>
                    Open on
                  </Typography.Caption>
                  <DayChipsRow>
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
                  </DayChipsRow>
                </>
              ) : (
                openingHourFields.map((field, index) => {
                  const isClosed = watch(`openingHours.${index}.isClosed`);
                  return (
                    <DayRow key={field.id}>
                      <DayName>{DAY_NAMES[field.dayOfWeek]}</DayName>

                      {!isClosed ? (
                        <TimeGroup>
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
                        </TimeGroup>
                      ) : (
                        <ClosedText color={theme.colorTextSecondary}>Closed</ClosedText>
                      )}

                      <Controller
                        control={control}
                        name={`openingHours.${index}.isClosed`}
                        render={({ field: { value, onChange } }) => (
                          <Switch
                            checked={!value}
                            onValueChange={(isOpen) => onChange(!isOpen)}
                            disabled={isSubmitting}
                          />
                        )}
                      />
                    </DayRow>
                  );
                })
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
            <NavGap />
          )}
          <NextPill onPress={handleNext} disabled={isSubmitting} activeOpacity={0.85}>
            {isSubmitting && isLastStep ? (
              <ActivityIndicator size="small" color={theme.colorBgContainer} />
            ) : isLastStep ? (
              <>
                <NavPillText>Create Store</NavPillText>
                <LucideIcon name="Check" size={15} color={theme.colorBgContainer} />
              </>
            ) : (
              <>
                <NavPillText>Next</NavPillText>
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

const TopBar = styled(View)`
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  padding-left: ${({ theme }) => theme.sizing.large}px;
  padding-right: ${({ theme }) => theme.sizing.regular}px;
  padding-top: ${({ theme }) => theme.sizing.xSmall}px;
`;

const CloseButton = styled(TouchableOpacity)`
  width: 32px;
  height: 32px;
  border-radius: ${({ theme }) => theme.borderRadius.full}px;
  background-color: ${({ theme }) => theme.colorBgLayout};
  align-items: center;
  justify-content: center;
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

const StepCounter = styled(Typography.Caption)`
  font-weight: 700;
  color: ${({ theme }) => theme.colorPrimary};
  letter-spacing: 1.2px;
  text-transform: uppercase;
  margin-bottom: 14px;
`;

const QuestionHeading = styled(Typography.H1)`
  color: ${({ theme }) => theme.colorText};
  margin-bottom: 8px;
`;

const QuestionSubtitle = styled(Typography.Body)`
  color: ${({ theme }) => theme.colorTextSecondary};
  margin-bottom: 28px;
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

const NavGap = styled(View)`
  width: 52px;
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

const NavPillText = styled(Typography.Body)`
  font-weight: 600;
  color: ${({ theme }) => theme.colorBgContainer};
  letter-spacing: 0.2px;
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

const ToggleText = styled(View)`
  flex: 1;
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

const DayName = styled(Typography.Body)`
  width: 90px;
  font-weight: 600;
`;

const TimeGroup = styled(View)`
  flex-direction: row;
  gap: ${({ theme }) => theme.sizing.xSmall}px;
  flex: 1;
  margin-left: ${({ theme }) => theme.sizing.xSmall}px;
  margin-right: ${({ theme }) => theme.sizing.xSmall}px;
`;

const ClosedText = styled(Typography.Caption)`
  flex: 1;
  margin-left: ${({ theme }) => theme.sizing.xSmall}px;
  margin-right: ${({ theme }) => theme.sizing.xSmall}px;
`;

const DayChipsRow = styled(View)`
  flex-direction: row;
  flex-wrap: wrap;
  gap: ${({ theme }) => theme.sizing.xSmall}px;
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
