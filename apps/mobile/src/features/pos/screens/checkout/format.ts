/**
 * Money formatting for the POS checkout flow.
 *
 * The cart works in integer paise (see cart.ts / money.ts). These helpers are
 * the single presentation point for that convention inside the checkout screens,
 * mirroring the reference POS formatting (₹ + en-IN grouping).
 */

/** Paise → "₹1,234.50" (always two decimals). */
export function formatPaise(paise: number): string {
  return `₹${(paise / 100).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** Paise → "1,234" or "1,234.50" (no symbol; hides the paise when whole).
 *  Used by the large amount card, which renders the ₹ symbol separately. */
export function formatAmount(paise: number): string {
  const rupees = paise / 100;
  const hasPaise = rupees % 1 !== 0;
  return rupees.toLocaleString('en-IN', {
    minimumFractionDigits: hasPaise ? 2 : 0,
    maximumFractionDigits: 2,
  });
}
