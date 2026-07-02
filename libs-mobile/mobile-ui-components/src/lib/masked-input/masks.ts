/**
 * Tiny format-string mask engine. Token meanings:
 *   9 — any single digit (0-9)
 *   A — any uppercase letter (A-Z), input lowercase is auto-upcased
 *   a — any lowercase letter (a-z), input uppercase is auto-downcased
 *   * — any alphanumeric character
 * Any other character in the format is treated as a literal separator that is
 * auto-inserted as the user types and is skipped on backspace.
 *
 * Examples:
 *   phoneUS:      "(999) 999-9999"
 *   date:         "99/99/9999"
 *   creditCard:   "9999 9999 9999 9999"
 *   creditCardCV: "999"
 */
export type MaskFormat = string;

export interface MaskPreset {
  format: MaskFormat;
  keyboardType?: "default" | "numeric" | "number-pad" | "phone-pad";
  maxLength: number;
}

export const MASK_PRESETS = {
  phoneUS: {
    format: "(999) 999-9999",
    keyboardType: "phone-pad",
    maxLength: 14,
  },
  phoneIN: {
    format: "+91 99999 99999",
    keyboardType: "phone-pad",
    maxLength: 15,
  },
  dateUS: {
    format: "99/99/9999",
    keyboardType: "number-pad",
    maxLength: 10,
  },
  dateISO: {
    format: "9999-99-99",
    keyboardType: "number-pad",
    maxLength: 10,
  },
  creditCard: {
    format: "9999 9999 9999 9999",
    keyboardType: "number-pad",
    maxLength: 19,
  },
  creditCardCV: {
    format: "999",
    keyboardType: "number-pad",
    maxLength: 3,
  },
  expiry: {
    format: "99/99",
    keyboardType: "number-pad",
    maxLength: 5,
  },
} as const satisfies Record<string, MaskPreset>;

export type MaskPresetKey = keyof typeof MASK_PRESETS;

const isToken = (ch: string): boolean =>
  ch === "9" || ch === "A" || ch === "a" || ch === "*";

const matchesToken = (token: string, ch: string): string | null => {
  switch (token) {
    case "9":
      return /\d/.test(ch) ? ch : null;
    case "A":
      return /[a-zA-Z]/.test(ch) ? ch.toUpperCase() : null;
    case "a":
      return /[a-zA-Z]/.test(ch) ? ch.toLowerCase() : null;
    case "*":
      return /[a-zA-Z0-9]/.test(ch) ? ch : null;
    default:
      return null;
  }
};

/**
 * Strips every character that isn't accepted by an input token (i.e. removes
 * formatting separators). Useful to recover the canonical value for storage.
 */
export function unmask(format: MaskFormat, value: string): string {
  let out = "";
  let fi = 0;
  for (const raw of value) {
    while (fi < format.length && !isToken(format[fi]!)) fi++;
    if (fi >= format.length) break;
    const accepted = matchesToken(format[fi]!, raw);
    if (accepted != null) {
      out += accepted;
      fi++;
    }
  }
  return out;
}

/**
 * Applies the mask, inserting separators after each accepted token. Rejected
 * characters are dropped (e.g. letter typed against a `9` slot).
 */
export function applyMask(format: MaskFormat, raw: string): string {
  let out = "";
  let ri = 0;
  for (let fi = 0; fi < format.length && ri < raw.length; fi++) {
    const fch = format[fi]!;
    if (isToken(fch)) {
      while (ri < raw.length) {
        const accepted = matchesToken(fch, raw[ri]!);
        ri++;
        if (accepted != null) {
          out += accepted;
          break;
        }
      }
    } else {
      out += fch;
      if (raw[ri] === fch) ri++;
    }
  }
  return out;
}
