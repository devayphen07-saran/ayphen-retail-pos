import type { CreateCustomerInput } from '@core/sync/mutations/enqueue-create-customer';
import type { CreateCustomerForm } from '../types/schema';

const orUndefined = (v: string | undefined) => (v && v.trim().length > 0 ? v.trim() : undefined);

/** Pure form → enqueueCreateCustomer's input shape. */
export function toCreateCustomerInput(values: CreateCustomerForm): CreateCustomerInput {
  const days = orUndefined(values.paymentTermDays);
  return {
    name: values.name.trim(),
    phone: orUndefined(values.phone),
    email: orUndefined(values.email),
    website: orUndefined(values.website),
    gstNumber: orUndefined(values.gstNumber),
    panNumber: orUndefined(values.panNumber),
    creditLimit: orUndefined(values.creditLimit),
    overrideCreditLimit: values.overrideCreditLimit || undefined,
    paymentTermDays: days != null ? Number(days) : undefined,
    addressLine1: orUndefined(values.addressLine1),
    addressLine2: orUndefined(values.addressLine2),
    city: orUndefined(values.city),
    district: orUndefined(values.district),
    stateLookupGuuid: orUndefined(values.state),
    pinCode: orUndefined(values.pinCode),
    birthday: orUndefined(values.birthday),
    anniversary: orUndefined(values.anniversary),
    notes: orUndefined(values.notes),
  };
}
