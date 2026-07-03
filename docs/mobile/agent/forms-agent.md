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

## 11A. One form for BOTH create and edit (reusability — default)

Write **one** `<Entity>Form.tsx` with an optional `record?` prop. **Create = edit with no record.**
Do NOT ship separate `New<Entity>Form` + `Edit<Entity>Form` that duplicate the same fields — that's a review reject.

- **Mode is derived, not passed:** `const isEdit = record != null`. Everything that differs comes from `record`/`isEdit` — nothing else changes (schema, validation, error map, loading, keyboard, a11y are all shared).
- **The five (and only five) differences:**
  1. `defaultValues` → `record ? recordToForm(record) : DEFAULT_*_VALUES`.
  2. dispatch → `update…` vs `add…`.
  3. payload → edit sends **only `dirtyFields`** (PATCH); create sends the full object.
  4. title/label → "Edit …"/"Save Changes" vs "New …"/"Create".
  5. post-success reset → `reset(data)` (edit) vs `reset()` (create).
- **Add a pure inverse mapper `recordToForm` in `transform.ts`** (the inverse of `formToApiPayload`). It MUST return **every** schema field and normalize `null → ''` — `dirtyFields`, the unsaved guard, and the PATCH all depend on it.
- **Edit submit:** if `dirtyFields` is empty → `onClose()` silently (no request); else PATCH only the changed keys, then `reset(data)`. **Create submit:** full payload, then `reset()`. `handleSubmitError` is shared verbatim.
- **PATCH transform:** the transform takes the changed-keys so an edit never emits `null` for an untouched optional (which would clobber it server-side).
- **Immutable-after-create fields** (GSTIN, SKU): keep them **in the one schema**; render `editable={!isEdit}` in edit mode and omit from the PATCH. Never delete a field from an "edit schema" — that desyncs form/record/API shapes.
- **Prefer passing `record` into `FormScreen`** — it computes `isEdit`, seeds `defaultValues` from a `toForm` prop, picks the title/label, and decides `reset(data)` vs `reset()`. The feature form only says *what to dispatch*.
- **Split into two components only** when create/edit diverge in **structure, not values** — different field sets, mutually-exclusive validation, or a create-wizard vs edit-single-screen. Even then, prefer one schema with `isEdit`-gated fields first; if you must split, both still use `FormScreen`, and state why in the PR.

---

## 12. Offline-first submission

Most Ayphen forms are offline-first. The submit dispatches an **offline-aware action** that
queues the mutation (the sync queue handles retry/conflict/sync). The form treats successful
queue insertion as success (close + "Saved — will sync when online"). Only if queue insertion
itself fails does the error handler run. The form pattern is identical online vs offline; only
the dispatched action differs. Never block the form waiting on the network.

---

## 13. Real-time interaction timing (the exact state machine)

This is the part that makes a form *feel* right. Every rule below is about **timing** — the
precise moment a state changes. Implement all of them; a form that passes the checklist but gets
the timing wrong still feels broken.

### 13.1 Field error — when it appears, updates, and clears

A field's error follows a strict lifecycle tied to `mode:'onBlur'` + `reValidateMode:'onChange'`:

| Moment | What happens | Why |
|---|---|---|
| User is typing, field never blurred | **NO error shown** yet, even if invalid | Don't nag mid-typing; the user isn't done |
| User leaves the field (blur), value invalid | **Error appears** under the field | Feedback exactly when they finish that field |
| User leaves the field (blur), value valid | No error | — |
| After first blur-error, user returns and types | Error **re-evaluates on every keystroke** and clears the instant the value becomes valid | `reValidateMode:'onChange'` — live correction |
| User submits with an untouched invalid field | **All errors appear at once** + focus/scroll to the first | `handleSubmit` validates everything |
| Server returns a `fieldError` after submit | Error appears under that field with the server message | `setError(field,{type:'server'})` |
| User edits a field holding a server error | Server error **clears on the next keystroke** | `reValidateMode:'onChange'` re-runs client validation, replacing it |

**Rule:** never show a field error while the user is still typing in a field they haven't left
yet (unless it already errored once). First feedback is on blur; after that, live.

### 13.2 Submit button — the exact enable/disable/loading transitions

The submit button has three inputs: `hasUnsavedChanges`, `isSubmitting`, and (implicitly)
validity. Its state at every moment:

| Moment | Button state | Rule |
|---|---|---|
| Form just opened (create), nothing typed | **Disabled** | `!hasUnsavedChanges` |
| Form just opened (edit), nothing changed | **Disabled** | `dirtyFields` empty |
| User types the first real change | **Enables** immediately | `hasUnsavedChanges` becomes true |
| User reverts all changes (type then erase) | **Disables again** | `dirtyFields` empties |
| A cascading `setValue` marks a field dirty | **Enables** | only if `setValue` passed `shouldDirty:true` |
| User taps Save | **Disables instantly + shows spinner** | `isSubmitting` flips true synchronously |
| Submit in flight (slow network) | Stays **disabled + spinner**, form still scrollable | prevents double-submit |
| Submit succeeds | Form closes (button state moot) | `reset()` + close |
| Submit fails (field errors) | **Re-enables** (spinner off); user fixes + retries | `isSubmitting` back to false |
| Submit fails (network/409) | **Re-enables**; toast shown; form stays open | user can retry |

**The disable expression is exactly:** `disabled={!hasUnsavedChanges || isSubmitting}` and
`loading={isSubmitting}`. Do NOT also gate on `isValid` — that would leave the button
permanently disabled on a fresh form the user hasn't errored yet, and it hides *why* Save does
nothing. Let the user tap Save on an invalid form; `handleSubmit` then surfaces the errors and
focuses the first one (13.4). The only things that disable Save are "nothing to save" and
"already saving."

**Timing subtlety:** `isSubmitting` must flip true in the same tick the tap is handled, before
any `await`. `handleSubmit(onSubmit)` does this for you — do not add your own `setLoading(true)`
that races the async boundary.

### 13.3 Loading state — what dims, what stays live

| Element | During submit |
|---|---|
| Submit button | disabled + spinner (`accessibilityState.busy=true`) |
| Form fields | stay **enabled and scrollable** — the user may review what they entered |
| Close/X button | stays **enabled** — the user can still cancel a slow submit |
| Background/overlay | optional subtle dim; never a full blocking spinner over the form |

Never throw a full-screen blocking spinner over a form mid-submit. The user should still see and
scroll their input. Only the Save action is locked.

### 13.4 Focus — the exact moments focus moves

| Moment | Focus behavior |
|---|---|
| Form opens | **Auto-focus the first field** (`autoFocus` on field 1), keyboard rises |
| User presses keyboard "next" (return key) | Focus **advances to the next field's ref** (`onSubmitEditing` → `nextRef.current?.focus()`) |
| User presses "done" on the last field | Focus leaves; `handleSubmit(onSubmit, onValidationError)` fires |
| Client validation fails on submit | Focus + scroll to the **first errored field** (RHF's `shouldFocusError` default + your `scrollToFirstError`) |
| Server returns field errors | Scroll to the **first server-errored field** (focus optional; scrolling is required so it's visible above the keyboard) |
| A field auto-fills another (country→currency) | **Do NOT move focus** — the user stays where they are; only the value updates |

**Rule:** focus moves on explicit user intent (return key) or to surface an error the user must
fix. It never jumps unexpectedly during typing or on a background cascade.

### 13.5 Keyboard — visibility and dismissal timing

| Moment | Keyboard behavior |
|---|---|
| Form opens | Rises with the auto-focused first field |
| User taps a button while keyboard is open | Keyboard dismisses AND the button's tap registers (`keyboardShouldPersistTaps="handled"`) — the first tap is NOT lost |
| User drags the scroll view down (iOS) | Keyboard dismisses interactively (`keyboardDismissMode="interactive"`) |
| Focused field near the bottom | `paddingBottom≥80` guarantees the field clears the keyboard so the user sees what they type |
| Last field, "done" pressed | Keyboard dismisses, submit fires |

### 13.6 Per-keystroke behavior (what runs on each character)

- **Before a field's first blur:** typing updates the value only. No validation runs for that
  field, no error renders. (Other already-errored fields still re-validate per their own state.)
- **After a field has errored once:** every keystroke re-runs that field's validation
  (`reValidateMode:'onChange'`) and clears the error the moment it's valid.
- **`hasUnsavedChanges` recomputes every keystroke** — so the Save button can enable/disable in
  real time as the user types and reverts.
- **Never** run the *whole form's* validation on every keystroke (that's `watch()` + top-level
  re-render — forbidden). Only the touched field re-validates; only components subscribed via
  `useWatch` re-render.

### 13.7 Unsaved-close — the exact prompt timing

| Moment | Behavior |
|---|---|
| User taps X, `dirtyFields` empty | Close **immediately**, no prompt |
| User taps X, `dirtyFields` non-empty | Show confirm modal: "Discard changes?" — Discard (destructive, right) / Keep editing (left) |
| Hardware back (Android), unsaved | Same confirm modal; intercept via `beforeRemove` + `e.preventDefault()` |
| User confirms Discard | `reset()` **then** close, in that order (clean form on reopen) |
| User taps Keep editing | Modal dismisses, form intact, focus returns to where it was |

### 13.8 The complete happy-path timeline (reference)

```
open form
  → field 1 auto-focused, keyboard up, Save DISABLED
user types name
  → Save ENABLES (hasUnsavedChanges=true)
presses "next"
  → focus → email field
types "john@", presses "next"
  → focus → phone; leaving email blurred it INVALID → email error appears NOW under email
returns to email, types the rest
  → error clears live on the keystroke it becomes valid
fills remaining, presses "done" on last field
  → handleSubmit fires
  → Save DISABLES + spinner (isSubmitting=true), fields stay live
server 422 { email: "taken" }
  → spinner off, Save RE-ENABLES, email shows "taken", scroll to email
user edits email
  → server error clears on first keystroke
presses Save
  → disable+spinner → success → reset() → toast "Saved" → form closes
```

Implement forms so this exact sequence holds. If any transition is off — Save enabled on an
empty form, error shown mid-typing, focus jumping on a cascade, keyboard eating the last field,
double-submit on a fast double-tap — the form is not done.

---

## 14. FORBIDDEN patterns (reject in review, refuse to write)

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
| separate `New…Form`+`Edit…Form` duplicating the same fields | ONE `<Entity>Form` with optional `record?` prop (§11A) |
| edit form re-declaring a second schema | one schema; gate immutable fields with `editable={!isEdit}` |
| Formik / final-form / Yux for new forms | react-hook-form + Zod |

---

## 15. Definition of done (self-check before returning any form code)

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

**Timing (§13):** no field error shows mid-typing before first blur · error appears on blur,
clears live after · Save disabled on fresh/reverted form, enables on first real change, disables
on revert · Save disables + spinner synchronously on tap, re-enables on failure · fields stay
live during submit · first field auto-focused on open · return-key advances focus, "done"
submits · submit-fail focuses/scrolls to first error · cascade does NOT move focus · unsaved-X
prompts, clean-X closes directly. Save is NOT gated on `isValid`.

**Tests present:** schema unit tests · transform unit tests · integration tests · and the four
manual scenarios below pass.

If any item fails, the form is not done.

---

## 16. The four manual scenarios every form must pass

1. **Type a char, delete it, tap Close** → closes with NO "unsaved changes" prompt.
2. **Fill all fields, airplane mode, Save** → "No internet connection…" toast; form stays open.
3. **Fill all fields, tap Save twice fast** → exactly ONE record; second tap is a no-op.
4. **Enter a duplicate email, Save** → email field shows "Already in use"; other fields
   untouched; form stays open.

---

## 17. Required file layout per feature

```
features/<entity>/
  schema.ts                 # Zod schema + DEFAULT_*_VALUES + type
  transform.ts              # formToApiPayload + recordToForm (both pure, inverse of each other)
  <Entity>Form.tsx          # ONE component, optional `record?` prop (create + edit); uses FormScreen
  <entity>Schema.test.ts    # schema unit tests
  transform.test.ts         # transform + recordToForm unit tests
  <Entity>Form.test.tsx     # integration tests (both create and edit paths)
```

One `<Entity>Form.tsx` serves create (`<Entity>Form onClose={…} />`) and edit (`<Entity>Form record={…} onClose={…} />`). Only split into `New<Entity>Form`/`Edit<Entity>Form` when the field set or validation genuinely differ (§11A) — not for value differences.

When reviewing or generating a form, ensure the tests exist. A form without schema + transform +
integration tests is incomplete.

---

## 18. Things to refuse or flag

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

## 19. FAQ answers to bake into decisions

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