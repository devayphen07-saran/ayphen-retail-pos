# CLAUDE.md — Ayphen Retail Forms (react-hook-form + Zod)

> Instructions for AI coding agents (Claude Code / Cursor / Copilot) writing or reviewing
> **any form** in the Ayphen Retail / Mini-POS mobile app.
> **Stack (fixed):** `react-hook-form` v7+ · `zod` v3+ · `@hookform/resolvers/zod`.
> These are **rules, not suggestions.** Every rule exists because a form in production
> violated it and a user got hurt. When a rule conflicts with a request, surface the conflict
> and follow the rule unless the human explicitly overrides it.
> **Never introduce Formik, final-form, Yup, or any alternative.** Consistency > preference.

---

## 0. Context you must hold

Forms in this app run under **hostile conditions**: intermittent connectivity, touch input
(every tap is a commitment), tiny screens (keyboard eats half the viewport), distracted
cashiers, and real consequences (a typo'd GSTIN is a compliance problem). Ad-hoc form code
routinely breaks in 13 specific ways: silent server errors, double-submission, lost typing on
close, no feedback until submit, stale `isDirty`, silent `setValue` cascades, `watch()`
re-render storms, keyboard hiding fields, no keyboard chaining, arrays via `setValue`, ignored
server validation, empty `defaultValues`, no `reset` after success. This file exists to make
those bugs structurally impossible.

---

## 1. Five principles that override everything

1. **Schema is the source of truth.** The Zod schema defines validity; the TS type derives via
   `z.infer`; `defaultValues` are shaped by it; the API payload transforms from it. NEVER
   duplicate validation in JSX, the submit handler, or custom guards.
2. **Server is the final authority.** Client validation is UX; server validation is
   correctness (uniqueness, business rules). Server field errors map back to specific fields
   via `setError`, not just a toast.
3. **No silent failures, ever.** Every failable promise is observable — mapped to a field,
   shown as a toast, or logged with context. **`.catch(() => {})` is forbidden, full stop.**
4. **Performance comes from scope.** `useWatch` not `watch`; `useFieldArray` not
   `getValues`/`setValue`; `useFormContext` not prop-drilling. Subscribe to the smallest slice.
5. **Loading states are mandatory.** Every async op has a visible state; the submit button
   disables the instant submission starts, so double-submits are structurally impossible.

---

## 2. The five-section anatomy (every form, this order)

A form file has exactly these sections. A sixth means it's custom — flag for senior review.

1. **Schema** — Zod object + `z.infer` type + exported `DEFAULT_*_VALUES` constant.
2. **Hook setup** — `useForm` with all required options.
3. **Close handler** — unsaved-changes guard.
4. **Submit handler** — transform → dispatch → error-map → reset.
5. **JSX** — `FormProvider` + `ScrollView` + fields + header.

---

## 3. Schema rules (Step 1)

- **Flat, never nested.** No `z.object({ form: {...} })` — field names propagate into
  `Controller` name props, `setError` keys, and the payload transform; a wrapper adds friction
  everywhere. Field names match the flat shape.
- **Use Zod built-ins.** `z.string().min(1, msg)` not `.nonempty()` (deprecated);
  `.email(msg)` not a hand-rolled regex.
- **Every validator carries a user-facing message** as the second arg. Never ship Zod's
  default ("String must contain at least 1 character(s)").
- **Optional text fields handle empty string:** `z.string().email(msg).optional().or(z.literal(''))`.
  RN inputs default to `''`, not `undefined`; a bare `.optional()` with `.email()` rejects `''`.
- **Reusable primitives live in `schemas/primitives.ts`** (indianPhone, gstin, pan, pincode,
  indianStateCode, moneyPaise, stableId, optionalEmail, optionalText…). Define once, import
  everywhere. When a rule changes, change the primitive, not N forms.
- **Cross-field validation uses `.refine()` with `path`.** The `path` tells RHF which field to
  highlight; without it the error attaches to the form root and the user can't see what to fix.
- **Export a `DEFAULT_*_VALUES` constant** shaped by the schema, alongside the type.
- **Payload transforms are pure functions in `transform.ts`**, never inline in `onSubmit`
  (trim, `null`-coalesce empty strings, uppercase GSTIN, etc.). They must be unit-testable.

---

## 4. Hook setup rules (Step 2)

```ts
useForm<T>({
  resolver: zodResolver(schema),
  mode: 'onBlur',            // REQUIRED — validate on leaving a field, not just submit
  reValidateMode: 'onChange',// REQUIRED — after first error, update per keystroke
  defaultValues: DEFAULT_T,  // REQUIRED — without it dirtyFields/isDirty lie
});
```

- **Never omit `mode`, `reValidateMode`, or `defaultValues`.** The RHF defaults are wrong for
  this UX. `mode:'onSubmit'` (the default) gives users a wall of errors after Save.
- **`defaultValues` must cover every field.** For edit forms, populate from the record and
  normalize `null → ''` at the boundary (`existing.email ?? ''`).
- **Use `dirtyFields`, never `isDirty`.** `isDirty` flips true on any interaction and STAYS
  true after a type-then-erase; `dirtyFields` is precise. Compute
  `const hasUnsavedChanges = Object.keys(dirtyFields).length > 0`.
- **Destructure `isSubmitting`** from `formState`.
- **Let TS infer callback params** from `useForm<T>` — don't re-annotate `onSubmit`.

---

## 5. Unsaved-changes guard (Step 3)

- Gate close on `hasUnsavedChanges` (from `dirtyFields`), NOT `isDirty`.
- Show a confirm modal where **the destructive action is the explicit one**:
  `confirmLabel: 'Discard'`, `cancelLabel: 'Keep editing'`. Never "OK/Cancel" where OK
  discards — that's caused decades of data loss.
- Call `reset()` **before** closing on confirm, so a reopen shows a clean form.
- No unsaved changes → close directly, no prompt.

---

## 6. Submit handler rules (Step 4)

- Wrap the dispatch in `try/catch`; on success: `reset()` (create) or `reset(data)` (edit) →
  close → success toast → optional `onSuccess` callback.
- **Route every error to a home** via a shared handler, in this precedence:
  1. `fieldErrors` object → `setError(field, { type:'server', message })` for each, then
     scroll to the first errored field. (A 422 with fieldErrors must NEVER fall through to a
     generic toast.)
  2. Network/offline → connection-specific toast.
  3. 401 → toast + logout.
  4. 403 → permission toast.
  5. 409 → conflict toast ("updated by someone else…").
  6. Error with `message` → toast the message.
  7. Fallback → generic toast AND `console.error` (never silent).
- **Wire both `handleSubmit` args:** `handleSubmit(onSubmit, onValidationError)`. The second
  scrolls to the first error on client-side validation failure — skipping it makes Save appear
  to "do nothing."
- **`reset()` after success is mandatory.** Otherwise `dirtyFields` and stale values persist to
  the next open. Edit forms use `reset(data)` to bake the saved values in as the new default.
- **Edit forms send only `dirtyFields` (PATCH semantics)** — smaller payload, avoids clobbering
  concurrent edits, cleaner audit diffs. If `dirtyFields` is empty, close silently.

---

## 7. JSX rules (Step 5)

- Wrap in `<FormProvider {...formData}>` so nested fields use `useFormContext()` — no
  prop-drilling `control` past 1 level.
- **Submit button:** `disabled={!hasUnsavedChanges || isSubmitting}` AND `loading={isSubmitting}`.
  Both conditions required — `!hasUnsavedChanges` stops empty-form saves; `isSubmitting` stops
  double-submits. Either alone leaves a hole.
- **Keyboard chaining on every text input:** set `returnKeyType` + `onSubmitEditing`. Middle
  fields `"next"` → focus next ref; last field `"done"` → `handleSubmit(onSubmit, onValidationError)`.
- **ScrollView config:** `keyboardShouldPersistTaps="handled"`,
  `keyboardDismissMode="interactive"`, `contentContainerStyle={{ paddingBottom: 80 }}` (last
  field must clear the keyboard).
- **Required fields** use the `<Input required>` prop (renders `*` + sets aria-required). NEVER
  duplicate the required rule in JSX — schema owns it.
- `autoFocus` the first field; set `keyboardType`/`autoCapitalize`/`autoCorrect`/`maxLength`
  appropriately (email-address, phone-pad, etc.).

---

## 8. Performance rules

- **`useWatch({ control, name })` in a scoped child, never top-level `watch('field')`.**
  Top-level `watch` re-renders the whole form on every keystroke — visible lag on long forms.
- **`useFormContext()` for fields 2+ levels deep**, not prop-drilled `control`.
- **Memoize cross-field callbacks** with `useCallback` so child field components don't re-render.
- **`setValue` ALWAYS passes options:** `{ shouldDirty: true, shouldValidate: true, shouldTouch: true }`.
  The defaults are all `false` — a cascading auto-fill (country → currency) without options
  leaves the field set but the form unaware (Save stays disabled, validation skipped,
  `dirtyFields` misses it).

---

## 9. Dynamic lists (arrays)

- **Use `useFieldArray`**, never `getValues`+`setValue` for arrays (breaks re-renders, per-item
  validation, and identity on reorder).
- **`key={field.id}`, never `key={index}`.** `field.id` is RHF's stable identity; `index`
  breaks component identity on reorder → fields show the wrong values.
- Methods: `append`/`prepend`/`insert`/`remove`/`move`/`update`/`swap`/`replace`.
- Validate the array in the schema: `z.array(itemSchema).min(1, 'Add at least one item')`.
  Array errors → `errors.items.message`; item errors → `errors.items[0].field.message`.

---

## 10. Accessibility (mandatory, not optional)

- Every interactive element has an `accessibilityLabel`.
- Required fields announce required state via the `required` prop.
- Field errors: `accessibilityRole="alert"` + `accessibilityLiveRegion="polite"`.
- Form-level errors: `role="alert"` + `accessibilityLiveRegion="assertive"`.
- Related fields grouped in a `View` with `accessibilityRole="group"` + label.
- Submit button reflects state: `accessibilityState={{ disabled, busy: isSubmitting }}`.

---

## 11. Prefer the `FormScreen` wrapper

A `FormScreen<TSchema>` component encapsulates provider + header + scroll view + close guard +
error mapping + loading states. New forms SHOULD use it so bug fixes propagate to every form and
the boilerplate can't drift. Only hand-roll the five sections when a form genuinely needs
behavior the wrapper doesn't cover — and say why.

---

## 12. Offline-first submission

Most Ayphen forms are offline-first. The submit dispatches an **offline-aware action** that
queues the mutation (the sync queue handles retry/conflict/sync). The form treats successful
queue insertion as success (close + "Saved — will sync when online"). Only if queue insertion
itself fails does the error handler run. The form pattern is identical online vs offline; only
the dispatched action differs. Never block the form waiting on the network.

---

## 13. FORBIDDEN patterns (reject in review, refuse to write)

| Forbidden | Required replacement |
|---|---|
| `.catch(() => {})` | map to `setError` or toast + log |
| `mode:'onSubmit'` (default) | `mode:'onBlur'` explicit |
| top-level `watch('field')` | `useWatch({ control, name })` scoped |
| `getValues`+`setValue` for arrays | `useFieldArray` |
| `key={index}` in `fields.map` | `key={field.id}` |
| `setValue(f, v)` no options | `setValue(f, v, { shouldDirty:true, shouldValidate:true })` |
| `isDirty` for unsaved guard | `Object.keys(dirtyFields).length > 0` |
| `z.string().nonempty()` | `z.string().min(1, msg)` |
| hand-rolled email regex | `z.string().email(msg)` |
| nested `z.object({ form: … })` | flat schema |
| missing `defaultValues` | always explicit |
| submit without `isSubmitting` disable | `disabled={isSubmitting}` |
| inline transform in `onSubmit` | pure fn in `transform.ts` |
| validation duplicated in JSX | schema only |
| prop-drilled `control` (3+ levels) | `useFormContext()` |
| server error → toast only, no field map | `setError(field)` then toast fallback |
| `handleSubmit(onSubmit)` (one arg) | `handleSubmit(onSubmit, onValidationError)` |
| last input `returnKeyType="default"` | `"done"` + `onSubmitEditing={handleSubmit(...)}` |
| Formik / final-form / Yux for new forms | react-hook-form + Zod |

---

## 14. Definition of done (self-check before returning any form code)

**Schema:** flat · Zod built-ins · user-facing messages · optional text uses
`.optional().or(z.literal(''))` · primitives imported · cross-field `.refine()` has `path` ·
type via `z.infer` · `DEFAULT_*_VALUES` exported.

**Hook:** `mode:'onBlur'` · `reValidateMode:'onChange'` · explicit `defaultValues` ·
`dirtyFields` (not `isDirty`) · `isSubmitting` destructured.

**Submit:** no `.catch(()=>{})` · `fieldErrors`→`setError` · network/401/403/409 branches ·
generic fallback + `console.error` · `reset()` on success (`reset(data)` for edit) · transform
is a pure fn · edit sends only `dirtyFields`.

**JSX:** `<FormProvider>` · submit `disabled={!hasUnsavedChanges || isSubmitting}` +
`loading` · close guard via `dirtyFields` with Discard/Keep-editing + `reset()` before close ·
every input has `returnKeyType`+`onSubmitEditing` · last input submits · ScrollView
`keyboardShouldPersistTaps="handled"` + `keyboardDismissMode="interactive"` + `paddingBottom≥80`
· `accessibilityLabel` everywhere · required via prop · errors as `alert`.

**Perf:** scoped `useWatch` · `useFieldArray` w/ `key={field.id}` · cascading `setValue` has
options · nested-component callbacks memoized.

**Tests present:** schema unit tests · transform unit tests · integration tests · and the four
manual scenarios below pass.

If any item fails, the form is not done.

---

## 15. The four manual scenarios every form must pass

1. **Type a char, delete it, tap Close** → closes with NO "unsaved changes" prompt.
2. **Fill all fields, airplane mode, Save** → "No internet connection…" toast; form stays open.
3. **Fill all fields, tap Save twice fast** → exactly ONE record; second tap is a no-op.
4. **Enter a duplicate email, Save** → email field shows "Already in use"; other fields
   untouched; form stays open.

---

## 16. Required file layout per feature

```
features/<entity>/
  schema.ts                 # Zod schema + DEFAULT_*_VALUES + type
  transform.ts              # form ↔ API payload (pure)
  New<Entity>Form.tsx       # uses FormScreen
  Edit<Entity>Form.tsx      # uses FormScreen
  <entity>Schema.test.ts    # schema unit tests
  transform.test.ts         # transform unit tests
  New<Entity>Form.test.tsx  # integration tests
```

When reviewing or generating a form, ensure the tests exist. A form without schema + transform +
integration tests is incomplete.

---

## 17. Things to refuse or flag

- Request to add a **new form library** (Formik/Yup/etc.) → refuse; use RHF + Zod.
- Request for an **empty `.catch`** or to "just swallow the error" → refuse; every error gets a home.
- Request to **skip `defaultValues`** "because everything's empty" → refuse; `dirtyFields`
  depends on it.
- Request to **duplicate a validation rule in JSX** → flag; schema is the single source.
- Request to build a **50+ field single form** → flag; propose a multi-step/wizard flow with
  draft persistence to SQLite, then implement that.
- Request to gate a form's **submit without `isSubmitting`** disable → flag; double-submit risk.

When flagging: state the rule, the concrete user-facing risk, and the correct alternative in one
short note — then implement the correct version unless explicitly overridden.

---

## 18. FAQ answers to bake into decisions

- **Async field validation** ("is this email taken?") → `.refine(async …)` paired with
  `mode:'onBlur'` (runs on leave, not per keystroke) + a pending state on the field.
- **Filter/search forms** → RHF only if you need its validation/a11y; simple filters can use
  `useState`, apply immediately, no unsaved guard, no `reset`.
- **Redux/RTK Query** → fine. RHF owns form state; the store owns server state. Prefer
  `useMutation`/TanStack Query over thunks for clearer loading states.
- **Custom `.transform()` in schema** → only pure transforms; business-logic form→API mapping
  goes in `transform.ts`, not the schema.

---

*This file governs form behavior (validation, submit, state, a11y). Form APPEARANCE is the
design system's job — `<Input>`, `<Button>`, `<SelectCountry>` are design-system components that
internally wrap RHF's `Controller`; this file specifies how to USE them, not how to build them.
Keep this file authoritative: when it changes, review all forms for compliance within one sprint.*
