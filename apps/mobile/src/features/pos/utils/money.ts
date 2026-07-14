/** `products.sellingPrice` is a canonical 2dp rupee STRING (payload-helpers.ts
 *  `money`), not paise — the one conversion point between that convention and
 *  the ledger's integer-paise convention (docs/prd/accounts-and-ledger.md). */
export function rupeesStringToPaise(value: string | null | undefined): number {
  const n = Number(value ?? '0');
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}