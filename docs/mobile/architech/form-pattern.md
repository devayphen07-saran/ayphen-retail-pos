# Form Pattern — Mini-POS Canonical Guide

> **Status:** Canonical. All new forms MUST follow this pattern.
> **Stack:** `react-hook-form` v7+ · `zod` v3+ · `@hookform/resolvers/zod`
> **Owner:** Mobile Platform Team
> **Last reviewed:** 2026

---

## Table of Contents

1. [Why This Document Exists](#1-why-this-document-exists)
2. [Core Principles](#2-core-principles)
3. [The Anatomy of a Form](#3-the-anatomy-of-a-form)
4. [Step 1 — Schema Design](#4-step-1--schema-design)
5. [Step 2 — Hook Setup](#5-step-2--hook-setup)
6. [Step 3 — Unsaved Changes Guard](#6-step-3--unsaved-changes-guard)
7. [Step 4 — Submit Handler](#7-step-4--submit-handler)
8. [Step 5 — JSX Layout](#8-step-5--jsx-layout)
9. [Performance Patterns](#9-performance-patterns)
10. [Dynamic Lists with useFieldArray](#10-dynamic-lists-with-usefieldarray)
11. [Edit Forms vs Create Forms](#11-edit-forms-vs-create-forms)
12. [The FormScreen Wrapper](#12-the-formscreen-wrapper)
13. [Reusable Validation Primitives](#13-reusable-validation-primitives)
14. [Server Error Handling — Deep Dive](#14-server-error-handling--deep-dive)
15. [Accessibility Requirements](#15-accessibility-requirements)
16. [Forbidden Patterns](#16-forbidden-patterns)
17. [Pre-merge Checklist](#17-pre-merge-checklist)
18. [Testing Strategy](#18-testing-strategy)
19. [Real-World Scenarios](#19-real-world-scenarios)
20. [Migration Guide](#20-migration-guide)
21. [FAQ](#21-faq)

---

## 1. Why This Document Exists

Every form in the Mini-POS mobile app handles user input under conditions that are MORE hostile than a desktop web app:

- **Intermittent connectivity** — sync may take seconds or fail entirely
- **Touch input** — every tap is a commitment; no hover, no easy undo
- **Small screens** — keyboards eat half the viewport
- **Distracted users** — cashiers entering data between customer interactions
- **Real consequences** — a typo'd GSTIN or duplicate customer creates compliance and operational headaches

The forms in this app must therefore handle 13 specific failure modes that ad-hoc form code routinely gets wrong:

| # | Failure Mode | Consequence Without This Pattern |
|---|---|---|
| 1 | Silent server errors | User thinks save succeeded; data lost |
| 2 | Double-submission | Duplicate records created |
| 3 | Lost typing on close | User loses 5 minutes of input |
| 4 | No validation feedback until submit | User sees wall of errors at the end |
| 5 | Stale `isDirty` after reset | "Unsaved changes?" prompt when nothing changed |
| 6 | `setValue` cascades silently | Auto-filled fields never validated |
| 7 | `watch()` re-renders entire form | Visible input lag on multi-field forms |
| 8 | Keyboard hides last field | User can't see what they're typing |
| 9 | No keyboard chaining | Manual tap between every field |
| 10 | Dynamic lists via `setValue` | Items don't re-render correctly |
| 11 | Server validation errors ignored | Same submit fails repeatedly |
| 12 | Empty `defaultValues` | `isDirty`/`dirtyFields` give false results |
| 13 | No `reset` after success | Next form open shows stale data |

This document is the antidote. It is **prescriptive, not advisory**. Every rule exists because a form somewhere in production violated it and a user got hurt.

---

## 2. Core Principles

These five principles override any individual rule. When in doubt, return to them.

### Principle 1 — Schema is the source of truth

The Zod schema defines what's valid. The TypeScript types derive from the schema. The form's `defaultValues` are shaped by the schema. The API payload is transformed from the schema. **Never duplicate validation logic in JSX, in the submit handler, or in custom guards.**

```ts
// ✅ ONE place defines what "valid customer data" means
const customerSchema = z.object({...});
type CustomerForm = z.infer<typeof customerSchema>;  // type derives

// ❌ Don't add extra validation in JSX
<Input
  rules={{ required: true }}  // ← schema already says required; this is duplication
  ...
/>
```

### Principle 2 — Server is the final authority

Client-side validation is for UX (instant feedback, prevent obviously-wrong submissions). Server-side validation is for correctness (uniqueness, business rules, cross-tenant constraints). The form treats server errors as first-class — they map back to specific fields, not just toast messages.

```ts
// Server returns 422 with { fieldErrors: { email: 'Already in use' } }
// → setError('email', { message: 'Already in use' })
// → user sees the error UNDER the email field, can fix and resubmit
```

### Principle 3 — No silent failures, ever

If a promise can fail, the failure is observable. The error is mapped to a field, surfaced as a toast, or logged with context. **Empty `.catch(() => {})` is a fireable offense** — it actively destroys user trust by making the app feel broken.

### Principle 4 — Performance comes from scope

`useWatch` instead of `watch`. `useFieldArray` instead of `getValues`/`setValue`. `useFormContext` instead of prop-drilling `control`. The principle: subscribe to the smallest possible slice of form state in each component, and only the components that need to re-render do.

### Principle 5 — Loading states are mandatory

Every async operation has a visible state: button disabled, spinner shown, content dimmed. The user always knows when something is happening. Double-submits are structurally impossible because the submit button disables the moment submission starts.

---

## 3. The Anatomy of a Form

Every form in Mini-POS has exactly these five sections, in this order:

```
┌─ Form File ─────────────────────────────────────────────────────────┐
│                                                                     │
│  1. Schema           (Zod object + TS type)                         │
│                                                                     │
│  2. Hook Setup       (useForm with all options)                     │
│                                                                     │
│  3. Close Handler    (unsaved-changes guard)                        │
│                                                                     │
│  4. Submit Handler   (transform → dispatch → error map → reset)     │
│                                                                     │
│  5. JSX              (FormProvider + ScrollView + fields + header)  │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

If your form has a sixth section, you're doing something custom — get a senior dev's review before merging.

---

## 4. Step 1 — Schema Design

### 4.1 Flat structure — never nested

```ts
// ❌ WRONG — nested under `form.` for no reason
const schema = z.object({
  form: z.object({
    displayName: z.string().min(1),
    email: z.string().email(),
  }),
});
// Field names become `form.displayName`, `form.email`
// → mismatch with server payload
// → mismatch with TS types
// → every component prefixes everything with `form.`

// ✅ RIGHT — flat
const schema = z.object({
  displayName: z.string().min(1),
  email: z.string().email(),
});
```

**Why this matters:** the schema field names propagate everywhere — into `Controller` `name` props, into `setError` keys, into form payload transformation. A nested wrapper adds typing friction at every reference site and creates a translation layer between form, server, and types.

### 4.2 Use Zod built-ins

Zod has battle-tested validators for common formats. Use them.

```ts
// ❌ WRONG
z.string().nonempty('Required')              // deprecated in Zod v3.23+
z.string().regex(EMAIL_REGEX)                 // misses edge cases
z.string().min(8).max(8).regex(/^\d+$/)       // verbose

// ✅ RIGHT
z.string().min(1, 'Required')
z.string().email('Invalid email')
z.string().length(8, 'Must be 8 digits').regex(/^\d+$/, 'Digits only')
```

### 4.3 Always provide a user-facing message

Zod's default error messages are technical ("String must contain at least 1 character(s)"). Always provide a human message as the second argument.

```ts
// ❌ WRONG
z.string().min(1)
// User sees: "String must contain at least 1 character(s)"

// ✅ RIGHT
z.string().min(1, 'Display name is required')
// User sees: "Display name is required"
```

### 4.4 Optional fields — handle empty strings explicitly

React Native text inputs default to `''`, not `undefined`. A field with `.optional()` will reject `''` if it has additional validators.

```ts
// ❌ WRONG — fails for empty string because .email() rejects ''
email: z.string().email().optional(),

// ✅ RIGHT — allow empty string OR valid email
email: z.string().email('Invalid email').optional().or(z.literal('')),
```

The `.or(z.literal(''))` lets `''` pass; `.optional()` lets `undefined` pass. Both states map to "no value provided" semantically.

### 4.5 Reusable validation primitives

Validations that recur across forms (Indian phone, GSTIN, PAN) live in a shared module. Define once, import everywhere.

```ts
// schemas/primitives.ts
import { z } from 'zod';

export const indianPhone = z
  .string()
  .regex(/^[6-9]\d{9}$/, 'Enter a 10-digit phone starting with 6-9');

export const gstin = z
  .string()
  .regex(
    /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/,
    'Invalid GSTIN format',
  );

export const pan = z
  .string()
  .regex(/^[A-Z]{5}[0-9]{4}[A-Z]{1}$/, 'Invalid PAN format');

export const pincode = z
  .string()
  .regex(/^\d{6}$/, 'Pincode must be 6 digits');

export const indianStateCode = z
  .string()
  .regex(/^[0-9]{2}$/, 'Invalid state code')
  .refine(
    (val) => parseInt(val, 10) >= 1 && parseInt(val, 10) <= 38,
    'State code must be between 01 and 38',
  );

export const moneyPaise = z
  .number()
  .int('Amount must be a whole number of paise')
  .nonnegative('Amount cannot be negative')
  .max(99_999_99_99_99, 'Amount exceeds maximum allowed');

export const stableId = z.number().int().positive();
```

### 4.6 Per-form schema example

Putting it all together for a customer form:

```ts
// features/customers/schema.ts
import { z } from 'zod';
import { indianPhone, gstin, stableId } from '@/schemas/primitives';

export const customerSchema = z.object({
  displayName: z.string()
    .min(1, 'Display name is required')
    .max(100, 'Display name must be 100 characters or fewer'),

  email: z.string()
    .email('Invalid email')
    .optional()
    .or(z.literal('')),

  phoneNo: indianPhone
    .optional()
    .or(z.literal('')),

  countryId: stableId.nullable(),
  currencyId: stableId.nullable(),

  gstin: gstin
    .optional()
    .or(z.literal('')),

  notes: z.string()
    .max(500, 'Notes must be 500 characters or fewer')
    .optional()
    .or(z.literal('')),
});

export type CustomerForm = z.infer<typeof customerSchema>;

// Default values for new forms — populated empty, not undefined
export const DEFAULT_CUSTOMER_VALUES: CustomerForm = {
  displayName: '',
  email: '',
  phoneNo: '',
  countryId: null,
  currencyId: null,
  gstin: '',
  notes: '',
};
```

### 4.7 Cross-field validation with `.refine()`

When a field's validity depends on another field's value, use `.refine()` on the object level.

```ts
const storeSchema = z.object({
  gstin: gstin.optional(),
  gstRegistrationType: z.enum(['regular', 'composition']).optional(),
  stateCode: indianStateCode.optional(),
}).refine(
  // If gstin is set, gstRegistrationType is required
  (data) => !data.gstin || data.gstRegistrationType !== undefined,
  {
    message: 'GST registration type is required when GSTIN is provided',
    path: ['gstRegistrationType'],   // ← attach error to this field
  },
).refine(
  // If gstin is set, its first 2 chars must match stateCode
  (data) => !data.gstin || !data.stateCode || data.gstin.slice(0, 2) === data.stateCode,
  {
    message: 'GSTIN state code must match the selected state',
    path: ['gstin'],
  },
);
```

The `path` argument is critical — it tells RHF which field to highlight when the cross-field validation fails. Without `path`, the error attaches to the form root and the user can't see what to fix.

### 4.8 Transforms — schema → API payload

When the form shape differs from the API shape, define a transformation function. Keep it pure and testable.

```ts
// features/customers/transform.ts
import { CustomerForm } from './schema';

export interface CustomerApiPayload {
  display_name: string;
  email: string | null;
  phone: string | null;
  country_fk: number | null;
  currency_fk: number | null;
  gstin: string | null;
  notes: string | null;
}

export function customerFormToApiPayload(form: CustomerForm): CustomerApiPayload {
  return {
    display_name: form.displayName.trim(),
    email: form.email?.trim() || null,
    phone: form.phoneNo?.trim() || null,
    country_fk: form.countryId,
    currency_fk: form.currencyId,
    gstin: form.gstin?.trim().toUpperCase() || null,
    notes: form.notes?.trim() || null,
  };
}
```

Test this function in isolation. It should never live inline inside `onSubmit`.

---

## 5. Step 2 — Hook Setup

### 5.1 Every `useForm` option matters

```ts
const formData = useForm<CustomerForm>({
  resolver: zodResolver(customerSchema),
  mode: 'onBlur',
  reValidateMode: 'onChange',
  defaultValues: DEFAULT_CUSTOMER_VALUES,
  // shouldFocusError: true is the default — keep it
  // shouldUseNativeValidation: false is the default — keep it
  // criteriaMode: 'firstError' is the default — keep it
});
```

| Option | Required Value | Why |
|---|---|---|
| `resolver` | `zodResolver(yourSchema)` | Connects Zod to RHF |
| `mode` | `'onBlur'` | Validate when user leaves a field — not just on submit |
| `reValidateMode` | `'onChange'` | After first error, update on every keystroke until valid |
| `defaultValues` | An object matching the schema | Without it, `dirtyFields` and `isDirty` lie |

**Never omit `mode`, `reValidateMode`, or `defaultValues`.** The defaults are wrong for our UX.

### 5.2 Why `mode: 'onBlur'`?

Default mode is `'onSubmit'`: errors appear ONLY after submit. The user fills 8 fields, hits Save, sees a wall of errors on fields they completed minutes ago, and has to scroll back through them.

With `mode: 'onBlur'`:
- User types `john@`
- User taps next field
- Email field shows: "Invalid email"
- User taps back, fixes it
- After first error, `reValidateMode: 'onChange'` kicks in — every keystroke now updates the error state until valid

This matches Stripe Checkout, Shopify admin, Linear forms. The user sees feedback when they're done with each field, not at the end.

### 5.3 Why `defaultValues` matters

```ts
// ❌ WRONG — no defaultValues
const form = useForm<CustomerForm>({ resolver });

// What this breaks:
// - dirtyFields is computed against the FIRST RENDER snapshot, not your intent
// - For controlled inputs that default to '', they register as "dirty" on first render
// - reset() doesn't know what state to return to
// - The unsaved-changes guard fires falsely

// ✅ RIGHT — explicit defaultValues for every field in the schema
const form = useForm<CustomerForm>({
  resolver,
  defaultValues: DEFAULT_CUSTOMER_VALUES,  // typed against schema
});
```

For **edit forms**, populate `defaultValues` from the existing record:

```ts
const form = useForm<CustomerForm>({
  resolver,
  defaultValues: {
    displayName: existingCustomer.displayName,
    email: existingCustomer.email ?? '',          // null → ''
    phoneNo: existingCustomer.phoneNo ?? '',
    countryId: existingCustomer.countryId,
    currencyId: existingCustomer.currencyId,
    gstin: existingCustomer.gstin ?? '',
    notes: existingCustomer.notes ?? '',
  },
});
```

Notice the `?? ''` pattern — the API may send `null` for optional fields, but text inputs need `''`. Normalize at the boundary.

### 5.4 Destructure what you need

```ts
const {
  control,
  handleSubmit,
  setValue,
  setError,
  reset,
  formState: { dirtyFields, isSubmitting, errors },
} = formData;

// Derived: did the user actually change anything?
const hasUnsavedChanges = Object.keys(dirtyFields).length > 0;
```

**Never destructure `isDirty`.** It's too imprecise — flips true on the slightest interaction, even if the user reverts the change. Use `dirtyFields` and check `.length > 0`.

### 5.5 TypeScript — let inference work

```ts
// ❌ DON'T explicitly type everything
const onSubmit: SubmitHandler<CustomerForm> = (data: CustomerForm) => {...};

// ✅ Let TS infer from useForm<CustomerForm>
const onSubmit = (data: CustomerForm) => {...};
```

The `z.infer<typeof customerSchema>` type flows through `useForm<CustomerForm>` and into every callback parameter. Trust the inference.

---

## 6. Step 3 — Unsaved Changes Guard

### 6.1 The guard implementation

```ts
const onClose = () => {
  if (hasUnsavedChanges) {
    ConfirmCloseModal({
      title: 'Discard changes?',
      message: 'Your changes will be lost. This cannot be undone.',
      confirmLabel: 'Discard',
      cancelLabel: 'Keep editing',
      destructive: true,
      onConfirm: () => {
        reset();           // clear form state before closing
        setOpen(false);
      },
    }).showConfirm();
  } else {
    setOpen(false);
  }
};
```

### 6.2 Why `dirtyFields` not `isDirty`

`isDirty` flips true the moment the user interacts. If they type "a" then delete it, `isDirty` STAYS true. The form value matches the default, but the user is told they have unsaved changes.

`dirtyFields` is precise — a field is included only when its CURRENT value differs from its default. Type "a" then delete it, the field is no longer in `dirtyFields`. The guard correctly reports "nothing changed."

```ts
// State: defaultValue = '', user typed and erased 'a'
isDirty                                       // true  ❌ wrong
Object.keys(dirtyFields).length > 0           // false ✅ right
```

### 6.3 Confirm modal — always destructive-as-default

The confirm button is the destructive action ("Discard"). The cancel button is the safe action ("Keep editing"). Modals where "OK" discards work and "Cancel" preserves it have caused decades of data loss across the industry.

```ts
ConfirmCloseModal({
  // ✅ Destructive action is the explicit one
  confirmLabel: 'Discard',
  cancelLabel: 'Keep editing',

  // Wrong direction — DON'T do this
  // confirmLabel: 'OK',
  // cancelLabel: 'Cancel',
});
```

### 6.4 Reset before close

When the user confirms "Discard," call `reset()` BEFORE setting open to false. This clears the form state synchronously so if the user reopens immediately, they see a clean form.

---

## 7. Step 4 — Submit Handler

### 7.1 Full submit handler — every branch

```ts
const onSubmit = async (data: CustomerForm) => {
  try {
    const result = await dispatch(
      addCustomer({
        pathParam: { tenantId },
        bodyParam: customerFormToApiPayload(data),
      }),
    ).unwrap();

    reset();                                 // reset form for next open
    setOpen(false);
    ShowToast.success('Customer added');
    onSuccess?.(result);                     // optional callback for parent
  } catch (err) {
    handleSubmitError(err);
  }
};
```

### 7.2 The error handler — every error gets a home

```ts
const handleSubmitError = (err: unknown) => {
  // Type guard for our standard error shape
  const error = err as {
    name?: string;
    message?: string;
    code?: string;
    fieldErrors?: Record<string, string>;
    status?: number;
  };

  // 1. Server returned field-specific validation errors
  //    e.g., { fieldErrors: { email: 'Already in use', phoneNo: 'Invalid' } }
  //    → highlight each field with its specific error message
  if (error?.fieldErrors && typeof error.fieldErrors === 'object') {
    for (const [field, message] of Object.entries(error.fieldErrors)) {
      setError(field as keyof CustomerForm, {
        type: 'server',
        message: String(message),
      });
    }
    scrollToFirstError(error.fieldErrors);
    return;
  }

  // 2. Network failure — connection-specific message
  if (
    error?.name === 'NetworkError' ||
    error?.code === 'NETWORK_OFFLINE' ||
    !navigator.onLine
  ) {
    ShowToast.error('No internet connection. Check your network and try again.');
    return;
  }

  // 3. Auth expired mid-submit
  if (error?.status === 401) {
    ShowToast.error('Your session expired. Please log in again.');
    dispatch(logout());
    return;
  }

  // 4. Permission denied — server returned 403
  if (error?.status === 403) {
    ShowToast.error(error?.message ?? 'You don\'t have permission to do this.');
    return;
  }

  // 5. Conflict — typically duplicate or stale state
  if (error?.status === 409) {
    ShowToast.error(error?.message ?? 'This record was updated by someone else. Refresh and try again.');
    return;
  }

  // 6. Server error with a usable message
  if (error?.message) {
    ShowToast.error(error.message);
    return;
  }

  // 7. Fallback — generic but never silent
  ShowToast.error('Could not save. Please try again.');

  // Log unknown errors for debugging
  console.error('[CustomerForm.submit] Unknown error:', err);
};
```

### 7.3 Validation-failure handler

```ts
const onValidationError = (errors: FieldErrors<CustomerForm>) => {
  // Called when handleSubmit's client-side validation fails.
  // Scroll to the first errored field so user can see it.
  scrollToFirstError(errors);
};

const scrollToFirstError = (errors: Record<string, unknown>) => {
  const firstField = Object.keys(errors)[0];
  if (firstField && scrollViewRef.current?.scrollToField) {
    scrollViewRef.current.scrollToField(firstField);
  }
};
```

### 7.4 Wiring both handlers

```ts
// handleSubmit takes TWO arguments:
// - onValid:   called when validation passes
// - onInvalid: called when validation fails
<ModalHeader
  onPressRight={handleSubmit(onSubmit, onValidationError)}
  ...
/>
```

Most code only passes `onSubmit`. Skipping `onValidationError` means when validation fails, nothing scrolls to the error — the user sees Save tap do nothing, then has to hunt for the red text.

### 7.5 Why `reset()` after success?

After a successful submit:

- `dirtyFields` still contains every field the user touched
- `defaultValues` still holds the original empty state
- If the user reopens this form to add ANOTHER customer, the old values are still there

`reset()` with no arguments returns the form to `defaultValues`. The next render shows clean inputs.

For **edit** forms, pass the saved data so the new "default" is the saved state:

```ts
// Create form: clear everything
reset();

// Edit form: bake in the new saved values
reset(data);  // dirtyFields now empty, but values stay populated
```

---

## 8. Step 5 — JSX Layout

### 8.1 The complete JSX template

```tsx
import { useRef } from 'react';
import { ScrollView, TextInput } from 'react-native';
import { FormProvider } from 'react-hook-form';

function NewCustomerForm({ setOpen }: Props) {
  // ... formData, hasUnsavedChanges, onClose, onSubmit, onValidationError

  const scrollViewRef = useRef<EnhancedScrollView>(null);
  const emailRef = useRef<TextInput>(null);
  const phoneRef = useRef<TextInput>(null);
  const notesRef = useRef<TextInput>(null);

  return (
    <FormProvider {...formData}>
      <ModalHeader
        title="New Customer"
        onPressLeft={onClose}
        leftIcon="X"
        leftAccessibilityLabel="Close"
        onPressRight={handleSubmit(onSubmit, onValidationError)}
        rightLabel="Save"
        rightDisabled={!hasUnsavedChanges || isSubmitting}
        rightLoading={isSubmitting}
        rightAccessibilityLabel="Save customer"
      />

      <ScrollView
        ref={scrollViewRef}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        contentContainerStyle={styles.scrollContent}
      >
        <Input
          control={control}
          name="displayName"
          label="Display Name"
          required
          autoFocus
          returnKeyType="next"
          onSubmitEditing={() => emailRef.current?.focus()}
          accessibilityLabel="Display name"
        />

        <Input
          ref={emailRef}
          control={control}
          name="email"
          label="Email"
          keyboardType="email-address"
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="next"
          onSubmitEditing={() => phoneRef.current?.focus()}
          accessibilityLabel="Email address"
        />

        <Input
          ref={phoneRef}
          control={control}
          name="phoneNo"
          label="Phone"
          keyboardType="phone-pad"
          maxLength={10}
          returnKeyType="next"
          onSubmitEditing={() => notesRef.current?.focus()}
          accessibilityLabel="Phone number"
        />

        <SelectCountry
          name="countryId"
          control={control}
          onChangeCountry={(country) => {
            setValue('currencyId', country.defaultCurrencyId, {
              shouldDirty: true,
              shouldValidate: true,
              shouldTouch: true,
            });
          }}
        />

        <Input
          ref={notesRef}
          control={control}
          name="notes"
          label="Notes"
          multiline
          numberOfLines={3}
          returnKeyType="done"
          onSubmitEditing={handleSubmit(onSubmit, onValidationError)}
          accessibilityLabel="Notes (optional)"
        />

        {errors.root?.message && (
          <ErrorBanner role="alert">{errors.root.message}</ErrorBanner>
        )}
      </ScrollView>
    </FormProvider>
  );
}

const styles = {
  scrollContent: {
    paddingBottom: 80,   // ensures last field clears the keyboard
  },
};
```

### 8.2 `FormProvider` — eliminate prop-drilling

Wrapping the form in `<FormProvider {...formData}>` lets every nested component use `useFormContext()` to access `control` without prop-drilling:

```tsx
// ❌ WITHOUT FormProvider — every level passes control down
function ParentForm() {
  const { control } = useForm(...);
  return <AddressFieldset control={control} />;
}

function AddressFieldset({ control }) {
  return <StreetInput control={control} />;
}

function StreetInput({ control }) {
  return <Controller control={control} name="street" ... />;
}

// ✅ WITH FormProvider — components access via context
function ParentForm() {
  const form = useForm(...);
  return (
    <FormProvider {...form}>
      <AddressFieldset />
    </FormProvider>
  );
}

function StreetInput() {
  const { control } = useFormContext();
  return <Controller control={control} name="street" ... />;
}
```

### 8.3 Keyboard chaining

Every text input MUST set `returnKeyType` and `onSubmitEditing`. The flow:

| Field position | returnKeyType | onSubmitEditing |
|---|---|---|
| First field | `"next"` | `() => secondRef.current?.focus()` |
| Middle fields | `"next"` | `() => nextRef.current?.focus()` |
| Last field | `"done"` | `handleSubmit(onSubmit, onValidationError)` |

When the user presses the keyboard's return key, focus advances to the next field or submits if it's the last one. This matches iOS/Android conventions and eliminates the cashier having to tap each field manually.

### 8.4 Submit button — disabled and loading

```tsx
<ModalHeader
  rightDisabled={!hasUnsavedChanges || isSubmitting}
  rightLoading={isSubmitting}
/>
```

The disabled rule is:

- `!hasUnsavedChanges` → user hasn't changed anything; nothing to save
- `isSubmitting` → submit in progress; prevent double-tap

Both conditions disable the button. Either alone leaves a hole:

| Condition | Without `!hasUnsavedChanges` | Without `isSubmitting` |
|---|---|---|
| User opens form, taps Save immediately | Save fires with empty form | (no issue) |
| User taps Save, then taps Save again | (no issue) | Double-submit, duplicate created |

Both checks are required.

### 8.5 ScrollView configuration

```tsx
<ScrollView
  keyboardShouldPersistTaps="handled"
  keyboardDismissMode="interactive"
  contentContainerStyle={{ paddingBottom: 80 }}
>
```

| Prop | Why |
|---|---|
| `keyboardShouldPersistTaps="handled"` | Tapping a button while keyboard is open dismisses keyboard AND triggers button. Default `"never"` loses the first tap. |
| `keyboardDismissMode="interactive"` | iOS: dragging down dismisses keyboard. Standard iOS behavior. |
| `paddingBottom: 80` | Last field must clear the keyboard. 80px = ~1 full input row. |

### 8.6 Required field indicator

Required fields display a `*` next to the label AND set `accessibilityState.required` on the input. The `required` prop on the `<Input>` component handles both:

```tsx
<Input
  required           // shows "*" + sets aria-required
  label="Display Name"
  name="displayName"
  control={control}
/>
```

NEVER duplicate the required validation in JSX. The schema is the source of truth.

---

## 9. Performance Patterns

### 9.1 `useWatch` not `watch()`

```tsx
// ❌ WRONG — top-level watch re-renders ENTIRE form on every keystroke
function CustomerForm() {
  const { control, watch } = useForm(...);
  const supplierId = watch('supplierId');     // ← form re-renders on every keystroke
  return <LocationInput disabled={!supplierId} />;
}

// ✅ RIGHT — useWatch in a scoped component
function LocationSection() {
  const { control } = useFormContext();
  const supplierId = useWatch({ control, name: 'supplierId' });
  return <LocationInput disabled={!supplierId} />;
}
```

The difference:

| Approach | Re-render trigger |
|---|---|
| `watch('field')` at top of component | ANY field changes |
| `useWatch({ control, name: 'field' })` | Only that specific field changes |

On a 15-field form, `watch()` causes 15× the renders of `useWatch`. The user feels it as lag.

### 9.2 When to use `useFormContext`

When a field component is nested 2+ levels deep, switch from prop-drilling `control` to `useFormContext`:

```tsx
// 1 level deep — prop is fine
<Input control={control} name="name" />

// 2+ levels — useFormContext
function AddressFieldset() {
  const { control } = useFormContext();
  return <Input control={control} name="address.street" />;
}
```

### 9.3 Stable callbacks with `useCallback`

If a field component receives an `onChange` callback that affects other fields, memoize it:

```tsx
const onChangeCountry = useCallback((country: Country) => {
  setValue('currencyId', country.defaultCurrencyId, {
    shouldDirty: true,
    shouldValidate: true,
  });
}, [setValue]);

<SelectCountry onChangeCountry={onChangeCountry} ... />
```

Otherwise the callback identity changes on every render and `SelectCountry` re-renders unnecessarily.

### 9.4 `setValue` options — never default

`setValue` defaults to:

- `shouldDirty: false`
- `shouldValidate: false`
- `shouldTouch: false`

This means cascading updates DON'T mark the form dirty and DON'T trigger validation. If a country selection auto-fills the currency, but `setValue` is called without options, the currency field is set but:

- The form doesn't know it changed → save button stays disabled
- Validation doesn't run → invalid values persist silently
- `dirtyFields` doesn't include `currencyId` → unsaved-changes guard misses it

ALWAYS pass options:

```ts
setValue('currencyId', value, {
  shouldDirty: true,
  shouldValidate: true,
  shouldTouch: true,
});
```

---

## 10. Dynamic Lists with useFieldArray

### 10.1 The wrong way

```ts
// ❌ NEVER do this for dynamic lists
const items = getValues('items');
setValue('items', [...items, newItem]);
```

Problems:

- Doesn't trigger re-renders correctly
- Doesn't validate per-item
- `dirtyFields` gets confused about which items changed
- Identity tracking breaks on reorder

### 10.2 The right way — `useFieldArray`

```tsx
import { useFieldArray, useFormContext } from 'react-hook-form';

function LineItems() {
  const { control } = useFormContext();
  const { fields, append, remove, move, update } = useFieldArray({
    control,
    name: 'items',
  });

  return (
    <>
      {fields.map((field, index) => (
        <LineItemRow
          key={field.id}              // ✅ field.id, NOT index
          index={index}
          onRemove={() => remove(index)}
        />
      ))}

      <Button
        onPress={() =>
          append({
            productId: null,
            quantity: 1,
            unitPrice: 0,
          })
        }
        accessibilityLabel="Add line item"
      >
        Add Item
      </Button>
    </>
  );
}

function LineItemRow({ index, onRemove }: { index: number; onRemove: () => void }) {
  const { control } = useFormContext();

  return (
    <View style={styles.row}>
      <SelectProduct
        control={control}
        name={`items.${index}.productId`}
      />
      <Input
        control={control}
        name={`items.${index}.quantity`}
        label="Qty"
        keyboardType="numeric"
      />
      <Input
        control={control}
        name={`items.${index}.unitPrice`}
        label="Price"
        keyboardType="decimal-pad"
      />
      <IconButton
        icon="Trash2"
        onPress={onRemove}
        accessibilityLabel={`Remove item ${index + 1}`}
      />
    </View>
  );
}
```

### 10.3 Why `key={field.id}`?

`field.id` is RHF's stable identity for each array item. It survives reorders, deletions, and re-renders. Using `key={index}` breaks component identity when items reorder — React reuses the wrong component instances and you see fields display the wrong values.

### 10.4 useFieldArray methods

| Method | Use case |
|---|---|
| `append(value)` | Add item to end |
| `prepend(value)` | Add item to start |
| `insert(index, value)` | Add at specific position |
| `remove(index)` | Remove at index |
| `move(from, to)` | Drag-and-drop reorder |
| `update(index, value)` | Replace item entirely |
| `swap(a, b)` | Swap two items |
| `replace(values)` | Replace whole array |

### 10.5 Array-level validation

Validate the array structure in the schema:

```ts
const orderSchema = z.object({
  items: z.array(
    z.object({
      productId: z.number().int().positive().nullable(),
      quantity: z.number().int().min(1, 'Min 1'),
      unitPrice: z.number().nonnegative(),
    }),
  ).min(1, 'Add at least one item'),
});
```

Errors on the array itself surface as `errors.items.message`. Errors on individual items surface as `errors.items[0].quantity.message`.

---

## 11. Edit Forms vs Create Forms

Edit forms differ in three meaningful ways from create forms.

### 11.1 `defaultValues` populated from existing record

```ts
const formData = useForm<CustomerForm>({
  resolver: zodResolver(customerSchema),
  mode: 'onBlur',
  reValidateMode: 'onChange',
  defaultValues: {
    displayName: existingCustomer.displayName,
    email: existingCustomer.email ?? '',
    phoneNo: existingCustomer.phoneNo ?? '',
    countryId: existingCustomer.countryId,
    currencyId: existingCustomer.currencyId,
    gstin: existingCustomer.gstin ?? '',
    notes: existingCustomer.notes ?? '',
  },
});
```

Notice the `?? ''` normalization — API sends `null`, text input needs `''`.

### 11.2 Submit sends only `dirtyFields` (PATCH semantics)

```ts
const onSubmit = async (data: CustomerForm) => {
  const changedKeys = Object.keys(dirtyFields) as (keyof CustomerForm)[];

  if (changedKeys.length === 0) {
    setOpen(false);   // nothing changed; close silently
    return;
  }

  // Build patch with only changed fields
  const patch = Object.fromEntries(
    changedKeys.map((key) => [key, data[key]]),
  ) as Partial<CustomerForm>;

  try {
    const result = await dispatch(
      updateCustomer({
        pathParam: { tenantId, customerId: existingCustomer.id },
        bodyParam: customerFormToApiPayload(patch as CustomerForm),
      }),
    ).unwrap();

    reset(data);    // bake new values into defaultValues
    setOpen(false);
    ShowToast.success('Customer updated');
  } catch (err) {
    handleSubmitError(err);
  }
};
```

PATCH semantics — only send what changed. This:

- Reduces payload size on slow networks
- Avoids overwriting fields that were updated by someone else mid-edit
- Makes audit logs clearer (only changed fields show in the diff)

### 11.3 UI labels differ

```tsx
<ModalHeader
  title={existingCustomer ? 'Edit Customer' : 'New Customer'}
  rightLabel={existingCustomer ? 'Save Changes' : 'Create'}
/>
```

Small but important. "Create" implies a new record; "Save Changes" implies modification of an existing one.

---

## 12. The FormScreen Wrapper

The boilerplate in every form is identical: provider, header, scroll view, close handler, error mapping. Encapsulate it.

```tsx
// components/FormScreen.tsx
import { ReactNode } from 'react';
import { ScrollView, View, StyleSheet } from 'react-native';
import {
  FormProvider,
  useForm,
  type UseFormProps,
  type FieldErrors,
  type DefaultValues,
} from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';

interface FormScreenProps<TSchema extends z.ZodTypeAny> {
  title: string;
  schema: TSchema;
  defaultValues: DefaultValues<z.infer<TSchema>>;
  onSubmit: (data: z.infer<TSchema>) => Promise<void>;
  onClose: () => void;
  children: ReactNode;
  submitLabel?: string;
  /** Override mode if a specific form needs different validation timing */
  mode?: UseFormProps['mode'];
}

export function FormScreen<TSchema extends z.ZodTypeAny>({
  title,
  schema,
  defaultValues,
  onSubmit,
  onClose,
  children,
  submitLabel = 'Save',
  mode = 'onBlur',
}: FormScreenProps<TSchema>) {
  const formData = useForm<z.infer<TSchema>>({
    resolver: zodResolver(schema),
    mode,
    reValidateMode: 'onChange',
    defaultValues,
  });

  const {
    handleSubmit,
    reset,
    setError,
    formState: { dirtyFields, isSubmitting },
  } = formData;

  const hasUnsavedChanges = Object.keys(dirtyFields).length > 0;

  const handleClose = () => {
    if (hasUnsavedChanges) {
      ConfirmCloseModal({
        title: 'Discard changes?',
        message: 'Your changes will be lost.',
        confirmLabel: 'Discard',
        cancelLabel: 'Keep editing',
        destructive: true,
        onConfirm: () => {
          reset();
          onClose();
        },
      }).showConfirm();
    } else {
      onClose();
    }
  };

  const handleFormSubmit = async (data: z.infer<TSchema>) => {
    try {
      await onSubmit(data);
      reset();
    } catch (err) {
      handleSubmitError(err, setError);
    }
  };

  const onValidationError = (errors: FieldErrors<z.infer<TSchema>>) => {
    // Scroll-to-error logic, if scroll ref available
    const firstField = Object.keys(errors)[0];
    if (firstField) {
      // Implementation-specific scroll
    }
  };

  return (
    <FormProvider {...formData}>
      <View style={styles.flex}>
        <ModalHeader
          title={title}
          onPressLeft={handleClose}
          leftIcon="X"
          leftAccessibilityLabel="Close"
          onPressRight={handleSubmit(handleFormSubmit, onValidationError)}
          rightLabel={submitLabel}
          rightDisabled={!hasUnsavedChanges || isSubmitting}
          rightLoading={isSubmitting}
        />
        <ScrollView
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          contentContainerStyle={styles.content}
        >
          {children}
        </ScrollView>
      </View>
    </FormProvider>
  );
}

function handleSubmitError(
  err: unknown,
  setError: (field: string, error: { type: string; message: string }) => void,
) {
  const error = err as { fieldErrors?: Record<string, string>; message?: string };

  if (error?.fieldErrors) {
    for (const [field, message] of Object.entries(error.fieldErrors)) {
      setError(field, { type: 'server', message: String(message) });
    }
    return;
  }

  ShowToast.error(error?.message ?? 'Could not save. Try again.');
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { paddingBottom: 80 },
});
```

### 12.1 Usage

```tsx
function NewCustomerForm({ setOpen, tenantId }: Props) {
  return (
    <FormScreen
      title="New Customer"
      schema={customerSchema}
      defaultValues={DEFAULT_CUSTOMER_VALUES}
      onClose={() => setOpen(false)}
      submitLabel="Create"
      onSubmit={async (data) => {
        await dispatch(
          addCustomer({
            pathParam: { tenantId },
            bodyParam: customerFormToApiPayload(data),
          }),
        ).unwrap();
        setOpen(false);
        ShowToast.success('Customer added');
      }}
    >
      <Input name="displayName" label="Display Name" required />
      <Input name="email" label="Email" keyboardType="email-address" />
      <Input name="phoneNo" label="Phone" keyboardType="phone-pad" maxLength={10} />
    </FormScreen>
  );
}
```

The boilerplate vanishes. Every form gets the same close guard, the same loading states, the same error handling. Bug fixes propagate to every form.

---

## 13. Reusable Validation Primitives

Maintain a single `schemas/primitives.ts` file. Add new primitives here when they recur.

```ts
// schemas/primitives.ts
import { z } from 'zod';

// ── Identity ────────────────────────────────────────────────────────────

export const stableId = z.number().int().positive();
export const guuid = z.string().regex(/^[a-zA-Z0-9-]+$/, 'Invalid identifier');

// ── Indian-specific ─────────────────────────────────────────────────────

export const indianPhone = z
  .string()
  .regex(/^[6-9]\d{9}$/, 'Enter a 10-digit phone starting with 6-9');

export const gstin = z
  .string()
  .regex(
    /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/,
    'Invalid GSTIN format',
  );

export const pan = z
  .string()
  .regex(/^[A-Z]{5}[0-9]{4}[A-Z]{1}$/, 'Invalid PAN format');

export const pincode = z
  .string()
  .regex(/^\d{6}$/, 'Pincode must be 6 digits');

export const indianStateCode = z
  .string()
  .regex(/^[0-9]{2}$/, 'Invalid state code')
  .refine(
    (val) => {
      const num = parseInt(val, 10);
      return num >= 1 && num <= 38;
    },
    'State code must be between 01 and 38',
  );

// ── Money ───────────────────────────────────────────────────────────────

export const moneyPaise = z
  .number()
  .int('Amount must be a whole number of paise')
  .nonnegative('Amount cannot be negative')
  .max(99_999_99_99_99, 'Amount exceeds maximum allowed');

// ── Common text fields ──────────────────────────────────────────────────

export const personName = z
  .string()
  .min(1, 'Name is required')
  .max(100, 'Name must be 100 characters or fewer')
  .regex(/^[a-zA-Z\s.'-]+$/, 'Name contains invalid characters');

export const businessName = z
  .string()
  .min(1, 'Business name is required')
  .max(200, 'Business name must be 200 characters or fewer');

// ── Email — handles empty string ────────────────────────────────────────

export const optionalEmail = z
  .string()
  .email('Invalid email')
  .optional()
  .or(z.literal(''));

// ── Common helpers for optional strings ─────────────────────────────────

export const optionalText = (max = 500) =>
  z.string().max(max, `Must be ${max} characters or fewer`).optional().or(z.literal(''));
```

### 13.1 Composition

Forms compose these primitives:

```ts
import {
  personName,
  optionalEmail,
  indianPhone,
  pincode,
  stableId,
  optionalText,
} from '@/schemas/primitives';

export const customerSchema = z.object({
  displayName: personName,
  email: optionalEmail,
  phoneNo: indianPhone.optional().or(z.literal('')),
  pincode: pincode.optional().or(z.literal('')),
  countryId: stableId.nullable(),
  notes: optionalText(500),
});
```

When a primitive changes (e.g., business decides Indian phones can also start with 5), update the primitive once and every form picks it up.

---

## 14. Server Error Handling — Deep Dive

### 14.1 The standard error shape

All Mini-POS API errors conform to:

```ts
interface ApiError {
  status: number;                            // HTTP status
  code: string;                              // ErrorCode enum (VALIDATION_ERROR, etc.)
  message: string;                           // Human-readable
  fieldErrors?: Record<string, string>;      // Field-specific errors
  metadata?: Record<string, unknown>;        // Context for the error
}
```

Examples:

```jsonc
// 422 Unprocessable Entity — validation error
{
  "status": 422,
  "code": "VALIDATION_ERROR",
  "message": "Some fields are invalid",
  "fieldErrors": {
    "email": "Email is already in use",
    "phoneNo": "Phone must be 10 digits"
  }
}

// 409 Conflict — business rule
{
  "status": 409,
  "code": "DUPLICATE_GSTIN",
  "message": "Another store is already registered with this GSTIN",
  "metadata": { "conflictingStoreId": "store_abc123" }
}

// 403 Forbidden — permission denied
{
  "status": 403,
  "code": "PERMISSION_DENIED",
  "message": "You don't have permission to add customers"
}
```

### 14.2 Mapping `fieldErrors` to form

```ts
if (error.fieldErrors) {
  for (const [field, message] of Object.entries(error.fieldErrors)) {
    setError(field as keyof CustomerForm, {
      type: 'server',
      message: String(message),
    });
  }
  return;
}
```

The user sees the error UNDER the specific field. They fix that field, tap Save, and resubmit. The local error gets replaced when they type (because `reValidateMode: 'onChange'` kicks in).

### 14.3 Form-level errors via `errors.root`

For errors that don't map to a specific field:

```ts
setError('root.serverError', {
  type: 'server',
  message: 'A conflict occurred. Please refresh and try again.',
});

// Display:
{errors.root?.serverError?.message && (
  <ErrorBanner role="alert">{errors.root.serverError.message}</ErrorBanner>
)}
```

### 14.4 Server error precedence

The error handler checks errors in this order:

1. Field-specific (`fieldErrors`) → inline errors
2. Network / offline → toast about connection
3. Auth expired (401) → toast + logout
4. Permission denied (403) → toast with permission message
5. Conflict (409) → toast with conflict message
6. Generic with `message` → toast the message
7. Fallback → "Could not save" toast

This order matters. A 422 with `fieldErrors` should NEVER fall through to a generic toast — the user needs to see exactly which field is wrong.

---

## 15. Accessibility Requirements

Every form MUST meet these accessibility requirements. They're not optional — cashiers using TalkBack/VoiceOver or larger text settings depend on them.

### 15.1 Every interactive element has `accessibilityLabel`

```tsx
<Input
  accessibilityLabel="Display name"   // ✅
  label="Display Name"
  required
/>

<Button
  accessibilityLabel="Save customer"   // ✅
  label="Save"
/>
```

### 15.2 Required fields announce required state

```tsx
<Input
  required                            // sets accessibilityState.required = true
  label="Display Name"
  ...
/>
```

Screen reader announces: "Display name, required, edit text."

### 15.3 Errors announce as alerts

```tsx
{errors.email && (
  <Text
    role="alert"                      // RN: accessibilityRole="alert"
    accessibilityLiveRegion="polite"
  >
    {errors.email.message}
  </Text>
)}
```

When an error appears, the screen reader interrupts to announce it.

### 15.4 Form-level errors live-region

```tsx
{errors.root?.serverError && (
  <ErrorBanner
    accessibilityRole="alert"
    accessibilityLiveRegion="assertive"
  >
    {errors.root.serverError.message}
  </ErrorBanner>
)}
```

### 15.5 Group fields logically

If fields are related (address, contact info), wrap them in a `View` with `accessibilityRole="group"` and `accessibilityLabel`:

```tsx
<View accessibilityRole="group" accessibilityLabel="Contact information">
  <Input name="email" label="Email" />
  <Input name="phoneNo" label="Phone" />
</View>
```

### 15.6 Submit button reflects state

```tsx
<Button
  accessibilityLabel={isSubmitting ? "Saving" : "Save"}
  accessibilityState={{
    disabled: !hasUnsavedChanges || isSubmitting,
    busy: isSubmitting,
  }}
/>
```

Screen reader announces: "Save, button, disabled" when there's nothing to save, or "Saving, button, busy" while submission is in progress.

---

## 16. Forbidden Patterns

These appear in code reviews and MUST be rejected.

| ❌ Forbidden | ✅ Required Replacement |
|---|---|
| `.catch(() => {})` | Map to `setError` or show toast |
| `mode: 'onSubmit'` (the default) | `mode: 'onBlur'` explicitly |
| `watch('field')` at component top level | `useWatch({ control, name: 'field' })` |
| `getValues()` + `setValue()` for arrays | `useFieldArray` |
| `key={index}` in `fields.map` | `key={field.id}` |
| `setValue(field, value)` (no options) | `setValue(field, value, { shouldDirty: true, shouldValidate: true })` |
| `formState.isDirty` for unsaved guard | `Object.keys(dirtyFields).length > 0` |
| `z.string().nonempty()` | `z.string().min(1, 'Required')` |
| `z.string().regex(EMAIL_REGEX)` | `z.string().email('Invalid email')` |
| Nested schema like `z.object({ form: ... })` | Flat schema |
| Missing `defaultValues` in `useForm` | Always provide explicit `defaultValues` |
| `onPress={handleSubmit(onSubmit)}` without `isSubmitting` disable | Add `disabled={isSubmitting}` |
| Inline `transformPayload` in `onSubmit` | Extract to pure function in `transform.ts` |
| Validation duplicated in JSX | Schema only |
| Field component using prop-drilled `control` (3+ levels) | `useFormContext()` |
| Server error → only toast, no field mapping | `setError(field, ...)` then toast as fallback |
| Form submit with no `onValidationError` callback | Always pass second arg to `handleSubmit` |
| Last input's `returnKeyType="default"` | `returnKeyType="done"` + `onSubmitEditing={handleSubmit(...)}` |

---

## 17. Pre-merge Checklist

Before requesting code review on a form PR, the author MUST verify every item below.

### Schema
- [ ] Schema is flat (no nested `form.` wrapper)
- [ ] Uses Zod built-ins (`.email()`, `.min(1)`, etc.) — no deprecated `.nonempty()`
- [ ] Every validator has a user-facing message
- [ ] Optional text fields use `.optional().or(z.literal(''))`
- [ ] Reusable primitives imported from `schemas/primitives.ts`
- [ ] Cross-field validation uses `.refine()` with `path`
- [ ] Type derived via `z.infer<typeof schema>`
- [ ] Default values constant exported alongside schema

### Hook
- [ ] `useForm` has `mode: 'onBlur'` explicitly
- [ ] `useForm` has `reValidateMode: 'onChange'` explicitly
- [ ] `useForm` has `defaultValues` explicitly
- [ ] `dirtyFields` used for unsaved-changes guard (NOT `isDirty`)
- [ ] `isSubmitting` destructured from `formState`

### Submit
- [ ] No `.catch(() => {})` anywhere
- [ ] Server-side `fieldErrors` map to `setError(field, ...)`
- [ ] Network errors show connection-specific toast
- [ ] Auth errors (401) trigger logout
- [ ] Permission errors (403) show permission toast
- [ ] Conflict errors (409) show conflict-specific message
- [ ] Generic fallback toast for unknown errors
- [ ] Unknown errors logged via `console.error`
- [ ] `reset()` called after successful submit (or `reset(data)` for edit)
- [ ] Transform function is pure and lives in `transform.ts`

### JSX
- [ ] Wrapped in `<FormProvider {...formData}>`
- [ ] Submit button has `disabled={!hasUnsavedChanges || isSubmitting}`
- [ ] Submit button has `loading={isSubmitting}` (or equivalent)
- [ ] Cancel guard uses `dirtyFields`, shows confirm modal with "Discard"/"Keep editing"
- [ ] Confirm modal calls `reset()` before closing
- [ ] Every input has `returnKeyType` + `onSubmitEditing`
- [ ] Last input's `onSubmitEditing` calls `handleSubmit(onSubmit, onValidationError)`
- [ ] ScrollView has `keyboardShouldPersistTaps="handled"`
- [ ] ScrollView has `keyboardDismissMode="interactive"`
- [ ] ScrollView has `paddingBottom` ≥ 80
- [ ] All interactive elements have `accessibilityLabel`
- [ ] Required fields announce via `required` prop
- [ ] Errors announce via `accessibilityRole="alert"`

### Performance
- [ ] Top-level `watch()` replaced with `useWatch` (scoped)
- [ ] Dynamic arrays use `useFieldArray` with `key={field.id}`
- [ ] Cascading `setValue()` includes `{ shouldDirty: true, shouldValidate: true }`
- [ ] Callbacks passed to nested components are wrapped in `useCallback`

### Testing
- [ ] Form tested with airplane mode (offline)
- [ ] Form tested with double-tap on submit
- [ ] Form tested with type-then-erase-then-close (no false unsaved warning)
- [ ] Form tested with server-side validation error (duplicate email, etc.)

If any checkbox is unchecked, the PR is incomplete.

---

## 18. Testing Strategy

### 18.1 Unit tests — schema

```ts
// customerSchema.test.ts
import { customerSchema } from './schema';

describe('customerSchema', () => {
  it('accepts a valid customer', () => {
    expect(customerSchema.safeParse({
      displayName: 'Alice',
      email: 'alice@example.com',
      phoneNo: '9876543210',
      countryId: 1,
      currencyId: 1,
      gstin: '',
      notes: '',
    })).toMatchObject({ success: true });
  });

  it('rejects empty display name', () => {
    const result = customerSchema.safeParse({
      displayName: '',
      email: '',
      phoneNo: '',
      countryId: null,
      currencyId: null,
      gstin: '',
      notes: '',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toEqual(['displayName']);
    }
  });

  it('rejects invalid phone format', () => {
    const result = customerSchema.safeParse({
      displayName: 'Alice',
      email: '',
      phoneNo: '12345',                     // too short
      countryId: null,
      currencyId: null,
      gstin: '',
      notes: '',
    });
    expect(result.success).toBe(false);
  });

  it('accepts phones starting with 6, 7, 8, or 9', () => {
    for (const prefix of ['6', '7', '8', '9']) {
      const result = customerSchema.safeParse({
        displayName: 'Alice',
        email: '',
        phoneNo: `${prefix}876543210`,
        countryId: null,
        currencyId: null,
        gstin: '',
        notes: '',
      });
      expect(result.success).toBe(true);
    }
  });
});
```

### 18.2 Unit tests — transform

```ts
// transform.test.ts
import { customerFormToApiPayload } from './transform';

describe('customerFormToApiPayload', () => {
  it('converts empty strings to null', () => {
    expect(customerFormToApiPayload({
      displayName: 'Alice',
      email: '',
      phoneNo: '',
      countryId: 1,
      currencyId: 1,
      gstin: '',
      notes: '',
    })).toEqual({
      display_name: 'Alice',
      email: null,
      phone: null,
      country_fk: 1,
      currency_fk: 1,
      gstin: null,
      notes: null,
    });
  });

  it('uppercases and trims GSTIN', () => {
    const result = customerFormToApiPayload({
      displayName: 'Alice',
      email: '',
      phoneNo: '',
      countryId: 1,
      currencyId: 1,
      gstin: '  27aaapl1234c1z5  ',
      notes: '',
    });
    expect(result.gstin).toBe('27AAAPL1234C1Z5');
  });
});
```

### 18.3 Integration tests — form behavior

Use React Native Testing Library to exercise the full form:

```ts
import { render, fireEvent, waitFor } from '@testing-library/react-native';
import { NewCustomerForm } from './NewCustomerForm';

describe('NewCustomerForm', () => {
  it('disables save when nothing has changed', () => {
    const { getByLabelText } = render(<NewCustomerForm />);
    expect(getByLabelText('Save customer')).toBeDisabled();
  });

  it('enables save after typing in display name', () => {
    const { getByLabelText } = render(<NewCustomerForm />);
    fireEvent.changeText(getByLabelText('Display name'), 'Alice');
    expect(getByLabelText('Save customer')).not.toBeDisabled();
  });

  it('disables save after typing AND erasing display name', () => {
    const { getByLabelText } = render(<NewCustomerForm />);
    fireEvent.changeText(getByLabelText('Display name'), 'Alice');
    fireEvent.changeText(getByLabelText('Display name'), '');
    expect(getByLabelText('Save customer')).toBeDisabled();
  });

  it('shows validation error on blur for invalid email', async () => {
    const { getByLabelText, findByText } = render(<NewCustomerForm />);
    fireEvent.changeText(getByLabelText('Email address'), 'invalid');
    fireEvent(getByLabelText('Email address'), 'blur');
    expect(await findByText('Invalid email')).toBeTruthy();
  });

  it('maps server fieldErrors to inputs', async () => {
    const mockDispatch = jest.fn().mockReturnValue({
      unwrap: () => Promise.reject({
        fieldErrors: { email: 'Already in use' },
      }),
    });

    const { getByLabelText, findByText } = render(
      <NewCustomerForm dispatch={mockDispatch} />,
    );

    fireEvent.changeText(getByLabelText('Display name'), 'Alice');
    fireEvent.changeText(getByLabelText('Email address'), 'taken@example.com');
    fireEvent.press(getByLabelText('Save customer'));

    expect(await findByText('Already in use')).toBeTruthy();
  });

  it('disables save during submission', async () => {
    let resolveSubmit: () => void = () => {};
    const mockDispatch = jest.fn().mockReturnValue({
      unwrap: () =>
        new Promise<void>((resolve) => {
          resolveSubmit = resolve;
        }),
    });

    const { getByLabelText } = render(
      <NewCustomerForm dispatch={mockDispatch} />,
    );

    fireEvent.changeText(getByLabelText('Display name'), 'Alice');
    fireEvent.press(getByLabelText('Save customer'));

    expect(getByLabelText('Save customer')).toBeDisabled();
    resolveSubmit();
  });
});
```

### 18.4 Manual test scenarios

These four scenarios catch the most common form bugs. EVERY form must pass them before merge.

| # | Scenario | Expected behavior |
|---|---|---|
| 1 | Open form, type a character, delete it, tap Close | Form closes without "unsaved changes" prompt |
| 2 | Open form, fill all fields, turn on airplane mode, tap Save | Error toast: "No internet connection. Check your network and try again." Form stays open. |
| 3 | Open form, fill all fields, tap Save twice quickly | Only ONE record is created. Second tap is no-op. |
| 4 | Open form, enter duplicate email, tap Save | Email field shows "Already in use" error. Other fields untouched. Form stays open. |

If any scenario fails, the form is not ready to merge.

---

## 19. Real-World Scenarios

These are specific situations every Mini-POS form must handle correctly.

### 19.1 Cashier on weak network

**Situation:** Cashier fills the new-customer form at the register. Network is 2G; submit takes 8 seconds.

**Correct behavior:**
- Save button disables immediately on tap (no double-submit)
- Loading spinner appears on the Save button
- Form is still scrollable; user can review what they entered
- After 8 seconds, success toast appears, form closes
- If timeout/network fail: form stays open with toast "Check your network"

**Required by:** `isSubmitting` disable, `reset()` on success, error handler.

### 19.2 Manager edits while staff also edits

**Situation:** Manager opens "Edit Customer" on tablet. Cashier on phone simultaneously edits the same customer's phone number and saves first.

**Correct behavior when manager hits Save:**
- Server returns 409 Conflict with message: "This customer was updated by someone else. Refresh to see the latest version."
- Form shows toast with that message
- Manager's changes are not lost (form stays open)
- Manager can refresh, review the new state, and reapply changes

**Required by:** 409 conflict handling in `handleSubmitError`.

### 19.3 User types GSTIN incorrectly

**Situation:** User types `27ABCDE1234F1Z5` (correct length but wrong checksum).

**Correct behavior:**
- On blur from GSTIN field: error appears "Invalid GSTIN format"
- User goes back to field, fixes character
- On every keystroke after blur: error updates live (cleared when valid)
- Submit button stays disabled until GSTIN is valid

**Required by:** `mode: 'onBlur'`, `reValidateMode: 'onChange'`, GSTIN regex primitive.

### 19.4 User taps Close after partial entry

**Situation:** User has filled display name and email, then taps the X button.

**Correct behavior:**
- Confirm modal appears: "Discard changes? Your changes will be lost."
- Buttons: "Discard" (destructive, on the right) and "Keep editing" (on the left)
- Tapping "Discard" closes form and clears state
- Tapping "Keep editing" returns to the form with values intact

**Required by:** `hasUnsavedChanges` check in `onClose`.

### 19.5 Cascading auto-fill from country to currency

**Situation:** User selects "India" from country dropdown. Currency should auto-fill to "INR."

**Correct behavior:**
- Currency field updates immediately
- Currency field is marked dirty (Save button enables if it wasn't already)
- If user manually changes currency to something else, that overrides the auto-fill
- Validation runs on the new currency value

**Required by:** `setValue` with `{ shouldDirty: true, shouldValidate: true, shouldTouch: true }`.

### 19.6 Dynamic order line items

**Situation:** User builds an order with 3 line items, then removes the middle one.

**Correct behavior:**
- "Add Item" appends a new row
- "Remove" button removes that specific row
- Remaining items don't lose their values (no off-by-one bugs)
- Each item validates independently
- `dirtyFields.items` correctly reflects which items changed
- Removing an item marks the form dirty
- Submit sends only the array as it appears in the UI

**Required by:** `useFieldArray` with `key={field.id}`.

### 19.7 Server returns multiple field errors

**Situation:** User submits a customer form. Server returns:
```json
{
  "fieldErrors": {
    "email": "Email is already in use",
    "phoneNo": "Phone format is invalid"
  }
}
```

**Correct behavior:**
- Email field shows "Email is already in use" under it
- Phone field shows "Phone format is invalid" under it
- Form scrolls to the first errored field (email)
- Save button re-enables (was disabled during submit)
- User can fix BOTH fields and resubmit
- On retype, server-side errors clear (because `reValidateMode: 'onChange'`)

**Required by:** `setError` loop in error handler.

---

## 20. Migration Guide

If you have existing forms that don't follow this pattern, migrate them in this order.

### 20.1 Priority order

1. **`.catch(() => {})` removals** — highest impact, easiest to find. Search the codebase: `grep -r "catch(()" --include="*.tsx" --include="*.ts"`. Each occurrence is a silent failure waiting to hurt a user. Replace with the standard error handler.

2. **Missing `defaultValues`** — search for `useForm({` without `defaultValues:`. Add explicit defaults shaped by the schema.

3. **`mode: 'onSubmit'` (the default)** — search for `useForm` declarations. If `mode` isn't specified, add `mode: 'onBlur'` and `reValidateMode: 'onChange'`.

4. **Top-level `watch()`** — search for `watch(` not preceded by `use`. Replace with `useWatch` in the smallest possible component.

5. **`getValues` + `setValue` for arrays** — search for `setValue.*items` patterns. Replace with `useFieldArray`.

6. **Cascading `setValue` without options** — search for `setValue(` with only 2 arguments. Add `{ shouldDirty: true, shouldValidate: true }` as third.

7. **Nested schema wrappers** — search for `z.object({ form:`. Flatten.

8. **Submit buttons without disable/loading** — review every form's submit button. Add `disabled={!hasUnsavedChanges || isSubmitting}` and `loading={isSubmitting}`.

### 20.2 Migration template per form

For each form being migrated, in this order:

1. **Schema** — rewrite using primitives, add user-facing messages, flatten if nested
2. **Default values** — add a `DEFAULT_VALUES` constant matching the schema
3. **useForm options** — add `mode`, `reValidateMode`, `defaultValues`
4. **Destructure** — switch from `isDirty` to `dirtyFields`; pull `isSubmitting`
5. **Close handler** — use `hasUnsavedChanges`; add `reset()` before close
6. **Submit handler** — full error mapping, `reset()` on success, transform function
7. **JSX** — keyboard chaining, ScrollView config, accessibility labels
8. **Test** — run all four manual scenarios from section 18.4
9. **Refactor** — consider migrating to `FormScreen` wrapper

Average migration time: 30–60 minutes per form.

### 20.3 Codemods for common changes

For codebases with 20+ forms, write a codemod (jscodeshift) for:

- Adding `mode: 'onBlur'` and `reValidateMode: 'onChange'` to every `useForm` call
- Wrapping `setValue` calls with the option object
- Replacing `.catch(() => {})` with a placeholder that fails type-check (forces manual review)

---

## 21. FAQ

### Q: Can I use Formik / final-form / [other library] instead?

No. RHF is the canonical choice for this codebase because:

- It uses uncontrolled inputs → significantly fewer re-renders → measurable performance difference on long forms
- Native TypeScript support without extra packages
- Smaller bundle (~9KB) than alternatives
- Better RN integration (refs, focus management)
- Active maintenance, large ecosystem
- Industry-standard combination with Zod

Forms in this app must NOT introduce alternative libraries. Consistency outweighs personal preference.

### Q: Why Zod and not Yup?

- Zod has better TypeScript inference (`z.infer<typeof schema>` gives you full types for free)
- Zod's API is more composable (`.refine`, `.transform`, `.brand`)
- Yup's typings have known gaps in v1
- New code converges on Zod across the industry (tRPC, Astro, T3 stack all use it)

If you maintain an old form using Yup, leave it for now. Migrate to Zod next time you touch it.

### Q: Can I skip `defaultValues` if all my fields default to empty?

No. Even for "obvious" defaults like empty strings, you must declare them. Reasons:

- Makes `dirtyFields` reliable
- Documents the form's shape at one glance
- Type-checks the default values against the schema
- Makes edit forms a drop-in change (just change the defaults)

### Q: Why not use HTML5 `<form>` and native validation?

React Native doesn't have HTML5 forms. The pattern in this document is what works for RN. Web forms in the app (admin panel) use the same RHF + Zod stack for consistency.

### Q: Is `mode: 'onBlur'` slower because it validates more?

Marginally — validation runs on blur instead of only on submit. But:

- Zod validation is fast (< 1ms for typical form sizes)
- The UX benefit (instant feedback) outweighs the cost
- Without onBlur, users hit "wall of errors after submit" which is much worse

### Q: Can I add custom logic in the schema's `.transform()`?

Yes, but be cautious. Transforms run during validation. They should be pure (no API calls, no side effects, no DOM access). For business-logic transforms (form → API payload), use a separate function (see section 4.8).

### Q: What about forms that need async validation (e.g., "is this email available")?

Use `.refine` with an async function:

```ts
const emailSchema = z
  .string()
  .email()
  .refine(
    async (email) => {
      const result = await checkEmailAvailable(email);
      return result.available;
    },
    { message: 'Email is already in use' },
  );
```

Pair with `mode: 'onBlur'` so the async check runs when the user leaves the field, not on every keystroke. Show a loading state on the field while the check is pending.

### Q: How do I handle very long forms (50+ fields)?

Split into sections via tabbed/wizard UI:

- Each section is its own `FormProvider` OR a sub-section of the parent form
- Use `useWatch` and `useFormContext` aggressively
- Consider stepped progression with intermediate validation
- Persist draft to local SQLite so the user can resume

If a form is 50+ fields, the design problem comes first — talk to product about breaking it into a multi-step flow.

### Q: My form uses Redux. Is that fine?

Yes. The submit handler dispatches to Redux (or RTK Query) as shown throughout this document. RHF manages form state; Redux manages server state. They don't conflict.

If you're starting a new form, prefer RTK Query (`useMutation`) or TanStack Query over thunks for clearer loading states and built-in retry/caching.

### Q: What about offline submission?

For offline-first forms (which is most of Mini-POS):

1. Submit attempts to queue the mutation in the offline mutation queue
2. Mutation queue handles retry, conflict resolution, and sync
3. Form treats queue insertion as success (closes, shows "Saved — will sync when online")
4. If queue insertion itself fails (rare), error handler runs as normal

The form pattern in this document works identically for offline-first; the difference is in the action dispatched (offline-aware vs. direct API).

### Q: Can I use this pattern for filter forms (search, filter sidebar)?

Partially. Filter forms differ:

- No "save" — changes apply immediately
- No "unsaved changes" guard
- No `reset()` on a hidden close
- May use `useForm` for state but typically simpler

Use RHF for filter forms only if you need its validation or accessibility features. For simple filters, `useState` is fine.

### Q: What's the relationship between this document and the design system?

This document is about FORM BEHAVIOR (validation, submit, state management). The design system covers FORM APPEARANCE (input styles, spacing, colors).

Components like `<Input>`, `<Button>`, `<SelectCountry>` are design-system components that internally use RHF's `Controller`. The pattern in this document specifies how to USE those components, not how to BUILD them.

---

## Appendix A — Glossary

| Term | Definition |
|---|---|
| Schema | A Zod object defining the form's validation rules and inferred type |
| Resolver | The bridge between Zod and RHF; `zodResolver(schema)` |
| `defaultValues` | The form's initial values; basis for comparison in `dirtyFields` |
| `dirtyFields` | RHF's tracking of which fields have changed from `defaultValues` |
| `isDirty` | Imprecise; flips true on any interaction. Don't use. |
| `isSubmitting` | True from `handleSubmit` invocation until the submit Promise resolves |
| `setError` | RHF method to add a server-side validation error to a field |
| `setValue` | RHF method to programmatically update a field; MUST pass options |
| `reset` | RHF method to clear form state back to `defaultValues` |
| `useFieldArray` | RHF hook for dynamic array fields (line items, etc.) |
| `useWatch` | RHF hook for scoped subscription to specific fields |
| `useFormContext` | RHF hook to access form methods inside `FormProvider` |
| `FormProvider` | RHF component that exposes form methods via context |
| `Controller` | RHF component that wraps an input to integrate with form state |
| Field error | Validation error for a single field; appears under the field |
| Form error | Error not specific to one field; appears as banner or toast |
| `fieldErrors` | Server response format for field-specific validation errors |
| Cascading update | When one field's change triggers another field's update |

---

## Appendix B — File Layout per Feature

```
features/
  customers/
    schema.ts                 # Zod schema + default values constant + type
    transform.ts              # form → API payload + API → form (for edit)
    NewCustomerForm.tsx       # Form component, uses FormScreen
    EditCustomerForm.tsx      # Form component, uses FormScreen
    customerSchema.test.ts    # Schema unit tests
    transform.test.ts         # Transform unit tests
    NewCustomerForm.test.tsx  # Integration tests
```

This layout is non-negotiable. Reviewers should ask for missing files (especially tests).

---

## Appendix C — Useful Snippets

### Reusable error handler

```ts
// utils/handleFormError.ts
import type { UseFormSetError, FieldValues } from 'react-hook-form';

export function handleFormError<T extends FieldValues>(
  err: unknown,
  setError: UseFormSetError<T>,
  fallbackMessage = 'Could not save. Try again.',
): void {
  const error = err as {
    name?: string;
    message?: string;
    code?: string;
    fieldErrors?: Record<string, string>;
    status?: number;
  };

  if (error?.fieldErrors && typeof error.fieldErrors === 'object') {
    for (const [field, message] of Object.entries(error.fieldErrors)) {
      setError(field as any, { type: 'server', message: String(message) });
    }
    return;
  }

  if (error?.name === 'NetworkError' || error?.code === 'NETWORK_OFFLINE') {
    ShowToast.error('No internet connection. Check your network and try again.');
    return;
  }

  if (error?.status === 401) {
    ShowToast.error('Your session expired. Please log in again.');
    return;
  }

  if (error?.status === 403) {
    ShowToast.error(error?.message ?? "You don't have permission to do this.");
    return;
  }

  if (error?.status === 409) {
    ShowToast.error(error?.message ?? 'This record was updated by someone else.');
    return;
  }

  ShowToast.error(error?.message ?? fallbackMessage);
  console.error('[FormError]', err);
}
```

### Reusable scroll-to-error

```ts
// utils/scrollToFirstError.ts
import type { RefObject } from 'react';
import type { ScrollView } from 'react-native';
import type { FieldErrors } from 'react-hook-form';

export function scrollToFirstError(
  errors: FieldErrors,
  scrollViewRef: RefObject<ScrollView>,
  fieldRefs: Record<string, RefObject<any>>,
): void {
  const firstField = Object.keys(errors)[0];
  if (!firstField) return;

  const fieldRef = fieldRefs[firstField];
  if (!fieldRef?.current || !scrollViewRef.current) return;

  fieldRef.current.measureLayout(
    scrollViewRef.current,
    (_x: number, y: number) => {
      scrollViewRef.current?.scrollTo({ y: y - 80, animated: true });
      fieldRef.current.focus?.();
    },
    () => {},
  );
}
```

### Confirm-close modal contract

```ts
// components/ConfirmCloseModal.ts
export interface ConfirmCloseModalOptions {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  destructive?: boolean;
  onConfirm: () => void;
}

export function ConfirmCloseModal(opts: ConfirmCloseModalOptions): {
  showConfirm: () => void;
} {
  // Implementation depends on your modal system
  return {
    showConfirm: () => {
      // Show modal with opts.confirmLabel on the right (destructive),
      // opts.cancelLabel on the left
      // On confirm tap: opts.onConfirm()
    },
  };
}
```

---

**End of document.** Keep this in `docs/` and reference it in every form PR template.

When this document is updated, all forms must be reviewed for compliance within one sprint. The point of having a canonical pattern is that it stays canonical.
