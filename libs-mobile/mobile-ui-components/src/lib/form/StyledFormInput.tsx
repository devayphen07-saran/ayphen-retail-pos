import styled from 'styled-components/native';

import { inputStyles } from '../input/style';

// ─── Safe numeric extractor ───────────────────────────────────────────────────
//
// inputStyles() returns theme values that may be numbers OR strings like "8px".
// Number("8px") → NaN, which produces "border-radius: NaNpx" silently.
// parseFloat("8px") → 8, parseFloat(8) → 8, parseFloat("8") → 8.
// Using parseFloat(String(v)) handles all three cases without throwing.
//
// This function is module-level (not inside the interpolation) so it is
// never reallocated on render.
function num(value: unknown): number {
  const parsed = parseFloat(String(value));
  if (__DEV__ && Number.isNaN(parsed)) {
    console.warn(
      '[StyledFormInput] inputStyles returned a non-numeric value:',
      value,
    );
  }
  return Number.isNaN(parsed) ? 0 : parsed;
}

// ─── StyledFormInput ──────────────────────────────────────────────────────────
//
// Shared styled TextInput used by Input, PasswordInput, TextArea,
// MaskedInput, AmountInput. Centralises border/padding/font logic so every
// form field stays pixel-consistent under theme/scale changes.
//
// Props:
//   hasError   — switches border to colorError via inputStyles
//   disabled   — reduces opacity to 0.6; consumers must also pass editable={false}
//   $scale     — breakpoint scale multiplier (border-radius, padding)
//   $fontScale — accessibility font scale multiplier (font-size only)
//
// Focus ring:
//   StyledFormInput is a TextInput, so React Native handles the native focus
//   ring automatically. No $focused prop is needed here.
//
// Opacity vs background for disabled state:
//   opacity: 0.6 is used rather than background-color change because it dims
//   the placeholder text and any prefix/suffix content consistently.
//   Known iOS caveat: opacity on a View ancestor of a TextInput can cause
//   touch-through issues on some RN versions. StyledFormInput IS the TextInput
//   (not a wrapper View) so this caveat does not apply here.

export const StyledFormInput = styled.TextInput<{
  $hasError?:   boolean;
  $disabled?:   boolean;
  $scale:       number;
  $fontScale:   number;
}>`
  ${({ theme, $hasError, $scale, $fontScale }) => {
    const s = inputStyles(theme, $hasError);
    return `
      border-width:  ${num(s.borderWidth)}px;
      border-color:  ${String(s.borderColor)};
      border-radius: ${num(s.borderRadius) * $scale}px;
      padding:       ${num(s.padding) * $scale}px;
      font-size:     ${num(s.fontSize) * $fontScale}px;
      font-family:   ${String(s.fontFamily)};
      color:         ${String(s.color)};
    `;
  }}
  width: 100%;
  background-color: ${({ theme }) => theme.colorBgContainer};
  opacity: ${({ $disabled }) => ($disabled ? 0.6 : 1)};
`;

// ─── StyledFormFieldFrame ─────────────────────────────────────────────────────
//
// A View that mimics the Input border/padding so callers can place a TextInput
// plus prefix icons or suffix icons inside it as siblings, all within one
// visible "field" boundary.
//
// This component intentionally does NOT have $fontScale — font scaling is
// the responsibility of the TextInput placed inside it, not the frame itself.
//
// Focus ring:
//   This is a View — React Native does not automatically apply a focus ring
//   to Views. The Input component applies a focused border colour via the
//   style prop (highest specificity), which overrides the border-color set
//   in this template literal:
//
//     <StyledFormFieldFrame
//       style={{ borderColor: isFocused ? theme.colorPrimary : theme.colorBorder }}
//     />
//
//   This design keeps StyledFormFieldFrame's API minimal (no $focused prop)
//   while still allowing consumers to apply any border colour they need via style.
//   The style prop always wins over template literal CSS in styled-components/native.
//
// Disabled opacity caveat:
//   Unlike StyledFormInput (which IS a TextInput), StyledFormFieldFrame IS a
//   View wrapping a TextInput. On iOS React Native ≤ 0.72, applying opacity < 1
//   to a View that contains a TextInput can cause the TextInput to become
//   non-interactive even when editable={true}.
//
//   Safe workaround already in place: the Input component passes
//   editable={false} when disabled=true, so the TextInput is already
//   non-interactive by the time opacity dims it. The opacity is purely cosmetic.
//
//   If a future RN version reintroduces this bug, replace opacity here with:
//     background-color: ${({ theme, disabled }) =>
//       disabled ? theme.colorBgContainerDisabled : theme.colorBgContainer};
//   and set the TextInput's color to theme.colorTextDisabled.

export const StyledFormFieldFrame = styled.View<{
  $hasError?: boolean;
  $disabled?: boolean;
  $scale:     number;
}>`
  ${({ theme, $hasError, $scale }) => {
    const s = inputStyles(theme, $hasError);
    return `
      border-width:  ${num(s.borderWidth)}px;
      border-color:  ${String(s.borderColor)};
      border-radius: ${num(s.borderRadius) * $scale}px;
      padding:       ${num(s.padding) * $scale}px;
    `;
  }}
  flex-direction:   row;
  align-items:      center;
  background-color: ${({ theme }) => theme.colorBgContainer};
  opacity:          ${({ $disabled }) => ($disabled ? 0.6 : 1)};
`;