import type { CreatePaymentAccountRequest } from '@ayphen/api-manager';
import type { CreatePaymentAccountForm } from '../types/schema';

/** Pure form → create-request body (snake_case; undefined omits optionals). */
export function toCreatePaymentAccountBody(
  values: CreatePaymentAccountForm,
): CreatePaymentAccountRequest {
  const reference = values.reference?.trim();
  return {
    name: values.name.trim(),
    kind: values.kind,
    is_default: values.setDefault || undefined,
    details: reference ? { reference } : undefined,
  };
}
