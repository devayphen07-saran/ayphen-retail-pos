/**
 * Currency formatting helpers backed by Intl.NumberFormat. Some RN JS engines
 * ship an Intl.NumberFormat that implements `format`/`resolvedOptions` but not
 * `formatToParts` (e.g. a minimal ICU build) — separator/symbol detection
 * falls back to parsing formatted output when `formatToParts` is missing.
 *
 * Amounts are passed around as **integer minor units** (e.g. cents, paise) so
 * we never round-trip through floats. JPY-style currencies with zero decimals
 * are handled transparently via Intl's resolved options.
 */

export interface AmountFormatOptions {
  currency: string;
  locale?: string;
  minorUnitsOverride?: number;
}

interface ResolvedFormat {
  format: Intl.NumberFormat;
  fractionDigits: number;
  divisor: number;
  symbol: string;
  groupSeparator: string;
  decimalSeparator: string;
}

const cache = new Map<string, ResolvedFormat>();

function detectSeparators(format: Intl.NumberFormat): { group: string; decimal: string } {
  const parts = format.formatToParts(1234.5);
  return {
    group: parts.find((p) => p.type === "group")?.value ?? ",",
    decimal: parts.find((p) => p.type === "decimal")?.value ?? ".",
  };
}

function detectSymbol(format: Intl.NumberFormat): string {
  const parts = format.formatToParts(1);
  return parts.find((p) => p.type === "currency")?.value ?? "";
}

/**
 * Engines without `formatToParts` still implement plain `format`, so we infer
 * separators by formatting known values with the currency symbol stripped
 * out (plain "decimal" style never includes one) and reading off the
 * punctuation next to known digit positions.
 */
function detectSeparatorsFallback(locale: string): { group: string; decimal: string } {
  const decimalSample = new Intl.NumberFormat(locale, {
    useGrouping: false,
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(1.5);
  const decimal = decimalSample.match(/1(.)5/)?.[1] ?? ".";

  const groupSample = new Intl.NumberFormat(locale, {
    useGrouping: true,
    maximumFractionDigits: 0,
  }).format(1000);
  const group = groupSample.match(/1(.)000/)?.[1] ?? (decimal === "," ? "." : ",");

  return { group, decimal };
}

function escapeForCharClass(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
}

/** Strips digits, whitespace, and the already-detected separators from a
 * one-unit formatted sample, leaving just the currency symbol/code. */
function detectSymbolFallback(format: Intl.NumberFormat, group: string, decimal: string): string {
  const sample = format.format(1);
  const stripPattern = new RegExp(
    `[0-9\\s${escapeForCharClass(group)}${escapeForCharClass(decimal)}]`,
    "gu",
  );
  return sample.replace(stripPattern, "").trim();
}

export function resolveFormat({
  currency,
  locale = "en-US",
  minorUnitsOverride,
}: AmountFormatOptions): ResolvedFormat {
  const key = `${locale}|${currency}|${minorUnitsOverride ?? "auto"}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const format = new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    ...(minorUnitsOverride != null && {
      minimumFractionDigits: minorUnitsOverride,
      maximumFractionDigits: minorUnitsOverride,
    }),
  });

  const resolved = format.resolvedOptions();
  const fractionDigits = minorUnitsOverride ?? resolved.maximumFractionDigits ?? 2;
  const divisor = Math.pow(10, fractionDigits);
  const supportsFormatToParts = typeof format.formatToParts === "function";
  const { group, decimal } = supportsFormatToParts
    ? detectSeparators(format)
    : detectSeparatorsFallback(locale);

  const out: ResolvedFormat = {
    format,
    fractionDigits,
    divisor,
    symbol: supportsFormatToParts ? detectSymbol(format) : detectSymbolFallback(format, group, decimal),
    groupSeparator: group,
    decimalSeparator: decimal,
  };
  cache.set(key, out);
  return out;
}

/**
 * Formats minor units (or null) into the locale-aware currency string.
 * Returns "" for null/undefined so the TextInput shows the placeholder.
 */
export function formatMinorUnits(
  minor: number | null | undefined,
  opts: AmountFormatOptions,
): string {
  if (minor == null) return "";
  const { format, divisor } = resolveFormat(opts);
  return format.format(minor / divisor);
}

/**
 * Same as `formatMinorUnits` but skips the currency symbol. Useful when the
 * symbol is rendered as a fixed prefix outside the input.
 */
export function formatMinorUnitsNumeric(
  minor: number | null | undefined,
  opts: AmountFormatOptions,
): string {
  if (minor == null) return "";
  const { fractionDigits, divisor } = resolveFormat(opts);
  const value = minor / divisor;
  return new Intl.NumberFormat(opts.locale ?? "en-US", {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(value);
}

/**
 * Strips every non-digit from the user's input and reinterprets the remaining
 * digits as minor units. This is the "calculator-style" entry mode where the
 * cursor stays pinned to the right side and digits shift left as you type.
 *
 *   "" -> null
 *   "0" -> 0 (treat as zero, NOT null)
 *   "1" -> 1 minor unit
 *   "150" -> 150 minor units ($1.50)
 *   "abc" -> null (no digits)
 */
export function parseToMinorUnits(raw: string): number | null {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 0) return null;
  const parsed = Number.parseInt(digits, 10);
  return Number.isFinite(parsed) ? parsed : null;
}
