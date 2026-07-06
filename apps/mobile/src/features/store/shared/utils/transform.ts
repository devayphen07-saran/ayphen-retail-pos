import type { CreateStoreForm } from '../types/schema';

export interface CreateStorePayload {
  name: string;
  address?: string;
  phone?: string;
  email?: string;
  gst_number?: string;
}

/**
 * Pure form → payload normalization (forms-agent.md §3/§6: transforms belong
 * here, never inline in onSubmit).
 *
 * The backend's CreateStoreDtoSchema only accepts name/address/phone/email/
 * gst_number today — category, description, website, state/pincode split,
 * currency, PAN, business-reg-number, migration date, opening hours, and
 * "make default" are collected in the wizard for UI parity but have no
 * server-side field yet, so they're intentionally dropped here.
 */
export function toCreateStorePayload(values: CreateStoreForm): CreateStorePayload {
  const addressParts = [
    values.line1?.trim(),
    values.line2?.trim(),
    values.city?.trim(),
    values.state?.trim(),
    values.pincode?.trim(),
  ].filter(Boolean);

  const gstin = values.gstin?.trim().toUpperCase();

  return {
    name: values.name,
    address: addressParts.length > 0 ? addressParts.join(', ') : undefined,
    phone: values.phone?.trim() || undefined,
    email: values.email?.trim().toLowerCase() || undefined,
    gst_number: gstin || undefined,
  };
}
