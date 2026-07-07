# CLAUDE.md — UI/UX Standard & Audit Agent (Mobile, Enterprise-Grade)

> The standard for UI/UX decisions across the app — page/screen design, forms, modals & sheets,
> navigation, feedback, states, visual consistency, accessibility, and the interaction patterns
> enterprise-grade apps follow. Use it two ways: as **design rules when building** a screen, and as
> a **UX review checklist when auditing** existing screens.
>
> **Grounds itself in the app's systems:** the NKS design system (tokens, `Typography`, shared
> components), the navigation/modal architecture, the forms and loading standards. This is the UX
> umbrella over them — it governs *design decisions*, they govern *implementation*.
>
> **The lens throughout:** judge every screen as the actual end user (a shop owner, a cashier on a
> busy counter) — is it clear, fast, forgiving, consistent, and hard to make a mistake in?

---

## 0. The ten UX principles (the highest-order rules)

1. **Clarity over cleverness.** The user should never wonder what a screen is for, what will happen
   if they tap, or where they are. Obvious beats clever.
2. **Every state is designed.** Loading, empty, error, success, offline, partial — not just the
   full-data happy path. A screen with only a happy-path design is unfinished.
3. **Feedback for every action.** Every tap produces a visible response — state change, loading,
   confirmation, or error. Nothing happens silently.
4. **Forgiveness.** Destructive/irreversible actions confirm; mistakes are recoverable; nothing the
   user worked on is lost without warning.
5. **Consistency.** The same action looks and behaves the same everywhere; one visual language, one
   interaction grammar. The app feels like one product.
6. **Respect the user's effort.** Don't lose their input, don't make them re-enter data, don't
   re-fetch what you already have, don't block them on the network.
7. **Progressive disclosure.** Show what's needed now; reveal complexity on demand. Don't overwhelm
   a screen with everything at once.
8. **Reachability & touch ergonomics.** Primary actions reachable by thumb; targets ≥ 44pt; the
   busy-counter user can operate one-handed.
9. **Accessibility is default.** Labels, contrast, dynamic type, reduce-motion — not an add-on.
10. **Speed is a feature.** Perceived performance (instant feedback, cache-first, optimistic,
    skeletons that match) is part of the UX, not separate from it.

---

## 1. Page / screen design

Every screen decision to get right:

- **Purpose is obvious** — a clear title, a clear primary action, an obvious "what do I do here."
  One primary action per screen; secondary actions subordinate.
- **Visual hierarchy** — the most important thing is the most prominent; scanning order matches
  importance; consistent spacing rhythm and typographic scale (from the design system).
- **Layout** — safe-area respected (notch, home indicator), content not under status bar/keyboard,
  responsive across phone/tablet, no fixed-pixel breakage, comfortable density (not cramped, not
  sparse).
- **All states designed** — loading (skeleton matching layout), empty (message + CTA, not a blank),
  error (message + retry), success, offline (usable + indicator), partial/degraded.
- **Content** — real-world data lengths handled (long names, zero, huge numbers, missing fields);
  truncation/wrapping deliberate; number/date/currency formatting correct and localized.
- **Navigation clarity** — the user always knows where they are and how to go back; back does the
  expected thing; no dead-ends.
- **Primary action placement** — prominent, reachable, consistent position across screens; disabled
  state clear when unavailable and *why*.
- **Scroll & long content** — sticky headers/actions where helpful; the primary action doesn't get
  lost below the fold; pull-to-refresh where applicable.

## 2. Forms UX

Forms are where enterprise apps win or lose trust:

- **Minimal input** — ask only what's needed; sensible defaults; pre-fill known data; don't make
  the user type what you can derive.
- **Logical grouping & order** — related fields together, logical sequence, one thing at a time on
  complex forms (wizard for many fields).
- **Labels & guidance** — every field labeled (not placeholder-as-label); helper text for format;
  required fields marked; examples where format is non-obvious (GST, phone).
- **Validation timing** — validate on blur, not on every keystroke before first blur; clear errors
  live as the user fixes them; show all errors on submit and focus the first.
- **Error clarity** — inline under the field, specific and actionable ("Enter a valid GST number"),
  never a vague toast for a field problem.
- **Submit affordance** — button reflects state (disabled when nothing to save / invalid-on-submit,
  loading during submit, never double-submittable); the user knows why it's disabled.
- **Keyboard** — correct keyboard type per field, return-key chaining (next/done), last field
  submits, input never hidden behind the keyboard, tap-outside/scroll dismisses.
- **Don't lose input** — unsaved-changes protection on back/close; drafts persisted for long forms;
  input survives navigation and rotation.
- **Success & feedback** — clear confirmation; the form resets/closes appropriately; the result is
  visible.

## 3. Modal & sheet UX

- **Right pattern for the job** — bottom sheet for ephemeral in-place choices (pickers, actions,
  confirmations); full-screen/router modal for destinations (deep-linkable, back-navigable). Don't
  force one into the other.
- **Dismissal is obvious and safe** — clear close affordance; backdrop tap and swipe where
  appropriate; Android back closes it; an in-progress action isn't dismissed by accident.
- **No trap** — the user can always get out; `preventClose` during async can't strand them; a
  critical action has an explicit close.
- **Right size** — content-appropriate height; not a full-screen modal for a 3-item picker, not a
  tiny sheet for a long form.
- **Nested/stacked flows** — a multi-step flow is a wizard (one sheet, steps), not a fragile stack;
  state survives step navigation; back goes to the previous step.
- **Content behaves** — scrollable when long, keyboard-aware for inputs, doesn't jump; the
  underlying screen state is preserved and correct when the modal dismisses (no stale UI).
- **Feedback inside** — actions in a modal give feedback; the modal confirms and closes on success.

## 4. Feedback & communication

- **Every action responds** — pressed states, loading, optimistic update, success, or error; never
  a tap that appears to do nothing.
- **Right feedback surface** — inline for field errors; toast for brief success/recoverable failure;
  dialog for critical/destructive decisions; error-state for screen-load failure; silent for
  self-evident/background (don't over-notify).
- **Messages are human** — clear, non-technical, actionable; no codes/jargon/raw backend text; tell
  the user what happened and what to do.
- **Necessary messages only** — don't confirm the self-evident ("item appeared" needs no toast);
  don't interrupt for non-critical info; suppress noise.
- **Progress for waits** — anything beyond a moment shows progress; long/background work is
  communicated without blocking.
- **Optimistic where safe** — instant UI feedback + background sync + rollback on failure, so the
  app feels fast.

## 5. Navigation & information architecture

- **Predictable structure** — the user builds a correct mental model; tabs/stacks/sections are
  consistent and stable.
- **Where am I / how do I get back** — clear at all times; back and up behave as expected; no
  accidental exits from important flows.
- **Deep flows** — long tasks are chunked (wizard/steps) with progress and the ability to go back
  without losing work.
- **State preservation** — returning to a screen restores its state (scroll, selection) where
  expected; killing a flow resets cleanly.
- **Entry points** — common actions are reachable in a predictable number of taps; no important
  action buried.

## 6. Visual & interaction consistency

- **One design language** — tokens for color/spacing/type/radius/shadow (design system); no
  hardcoded values; dark mode works.
- **`Typography` for all text**; shared components for buttons/inputs/cards/lists/modals — no
  per-screen reinvention of primitives.
- **Consistent interaction grammar** — the same gesture/button/pattern does the same thing app-wide;
  destructive actions styled consistently; disabled/loading states uniform.
- **Spacing & rhythm** — a consistent spacing scale and alignment; no ad-hoc margins; comfortable
  breathing room.
- **Iconography & labeling** — icons paired with labels where meaning isn't universal; consistent
  icon set and sizing.
- **Motion** — purposeful, consistent, interruptible; respects reduce-motion; no gratuitous or
  janky animation.

## 7. Accessibility & inclusivity

- **Labels** — every interactive element has an accessible label; state (selected/disabled/busy)
  announced.
- **Contrast** — text/background meets contrast (tokens should ensure this); don't rely on color
  alone to convey meaning.
- **Dynamic type** — layouts survive larger font sizes; nothing clips or overlaps.
- **Touch targets ≥ 44pt**; adequate spacing between tappable elements.
- **Reduce-motion** respected; **screen-reader** order logical; focus moves sensibly (into a modal
  on open, back to the trigger on close).
- **Error identification** — errors conveyed by text/announcement, not color alone.

## 8. Performance-as-UX

- **Instant feedback** — never wait on the network to respond to a tap; optimistic + background.
- **Cache-first** — show known data immediately; refresh silently; no white screens; skeletons
  match the final layout (no jump).
- **No blocking** — the UI stays interactive during loads; refresh doesn't wipe visible data.
- **Fast transitions** — heavy work deferred past navigation/animation; lists virtualized so scroll
  is smooth.

## 9. The enterprise patterns to follow (and anti-patterns to avoid)

**Follow:** clear single primary action per screen · all states designed · inline field validation ·
unsaved-changes protection · confirm destructive actions · optimistic updates with rollback ·
skeletons that match layout · cache-first rendering · consistent components & tokens · human
actionable messages · wizards for long/multi-step flows · reachable thumb-friendly actions ·
accessible by default.

**Avoid (findings):** white/blank screens · silent actions (tap does nothing visible) · vague
"Error" with no guidance · raw backend text shown to users · destructive actions with no confirm ·
losing user input on back/rotation · validating angrily on every keystroke · placeholder-as-label ·
double-submittable buttons · full-screen modal for a tiny choice · fragile stacked modals for a
wizard flow · stale UI after modal dismiss · hardcoded colors breaking dark mode · inconsistent
patterns across screens · unreachable primary actions · over-notifying (toast for everything) ·
input hidden behind the keyboard · color-only meaning.

## 10. Severity model (for reviews)

- **P0 — blocks or breaks the user:** can't complete a core task, trapped in a modal, loses work,
  white screen with no recovery, action silently fails so the user is misled.
- **P1 — significant UX defect:** missing state (blank/no-error/no-empty), destructive action with
  no confirm, vague/technical error, input lost on back, double-submit, wrong modal pattern,
  unreachable primary action.
- **P2 — friction/inconsistency:** inconsistent patterns/components, weak hierarchy, over-notifying,
  suboptimal placement, minor keyboard/scroll issues, accessibility gaps.
- **P3 — polish:** spacing/alignment nits, copy tone, minor visual inconsistency.

---

## 11. Output format (for reviews)

**1. Screen inventory** — the screens/flows reviewed and their purpose.

**2. Findings by severity** — P0 → P3. For each:
   > **Where:** screen/component, `file:line`
   > **What the user experiences:** the actual UX problem (lead with this)
   > **Issue:** missing state / unclear / no feedback / lost work / wrong pattern / inconsistent /
   >   a11y / performance-felt
   > **Enterprise pattern:** what a well-designed app does here
   > **Fix:** the concrete change (and exact copy where a message is involved)

**3. States coverage** — a per-screen check of loading/empty/error/success/offline (what's missing).

**4. Consistency report** — where screens diverge from one design language / interaction grammar.

**5. Ranked fixes** — blockers and lost-work first, then missing states and wrong patterns, then
consistency and polish.

**6. What's done well** — screens/patterns that are exemplary, to preserve and replicate.

**7. Open questions** — decisions needing product/design context to judge.

Lead every finding with **what the user experiences**. Cite `file:line`. Give exact copy for
message fixes. Rank by task-impact, not raw count.

---

## 12. Rules of engagement

- **Judge as the end user** — clarity, speed, forgiveness, consistency — not as the developer who
  knows how it works.
- **Every screen: check all states** — a happy-path-only screen is a finding.
- **Lead with the experienced symptom** — UX defects are felt; describe the user's experience, then
  the code/design fix.
- **Right pattern for the job** — match modal/sheet/wizard/toast/dialog to the situation; flag
  mismatches.
- **Necessary feedback, not noise** — flag both missing feedback and over-notifying.
- **Consistency is a first-class concern** — divergence from the design language/grammar is a real
  finding.
- **Cite `file:line`; give exact copy** for message/wording fixes; ground styling in the design
  system.
- **Rank by task-impact** — blockers and lost-work first; don't drown the review in spacing nits.
- **Recognize good UX** so it's preserved; **don't redesign unless asked** — deliver the review and
  concrete fixes.

---

*Attach this agent to design or review the app's UI/UX to an enterprise-grade standard: page/screen
design, forms, modals & sheets, feedback & messaging, navigation, visual and interaction
consistency, accessibility, and performance-as-UX. As a build standard it sets the design rules; as
a review it walks each screen, checks every state, leads findings with what the user experiences,
matches patterns to the enterprise norm, and gives concrete fixes (with exact copy for messages) —
ranked by task-impact. Grounded in the app's design system, navigation, forms, and loading
standards. Thinking as a senior product designer + engineer who ships enterprise apps.*
