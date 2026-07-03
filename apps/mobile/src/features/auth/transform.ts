import type { PhoneForm } from './schema';

/**
 * Pure form → payload normalization (forms-agent.md §3/§6: transforms belong
 * here, never inline in onSubmit).
 */
export function normalizePhone(phone: PhoneForm['phone']): string {
  return phone.trim();
}

export function normalizeName(name: PhoneForm['name']): string {
  return name.trim();
}
