import type { PaymentAccountKind } from '@ayphen/api-manager';

/** Copy for the single (kind-agnostic) `reference` field. The value is stored as
 *  one `details.reference` string regardless of kind — only the label/placeholder
 *  adapt, so re-picking the kind never invalidates what was typed. */
export interface ReferenceFieldCopy {
  label: string;
  placeholder: string;
}

const REFERENCE_COPY: Record<PaymentAccountKind, ReferenceFieldCopy> = {
  bank: { label: 'Account number / IFSC', placeholder: 'e.g. 50100••3456 · HDFC0001234' },
  upi: { label: 'UPI ID', placeholder: 'e.g. name@okhdfc' },
  card: { label: 'Card (last 4)', placeholder: 'e.g. •••• 4242' },
  wallet: { label: 'Wallet / handle', placeholder: 'e.g. PhonePe · 98••••3210' },
  cash: { label: 'Reference', placeholder: 'Optional note' },
  other: { label: 'Reference', placeholder: 'Optional note' },
};

export function referenceFieldCopy(kind: PaymentAccountKind | undefined): ReferenceFieldCopy {
  return kind ? REFERENCE_COPY[kind] : REFERENCE_COPY.other;
}
