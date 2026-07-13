import type { CreateSupplierInput } from '@core/sync/mutations/enqueue-create-supplier';
import type { CreateSupplierForm } from '../types/schema';

const orUndefined = (v: string | undefined) => (v && v.trim().length > 0 ? v.trim() : undefined);

/** Pure form → enqueueCreateSupplier's input shape. */
export function toCreateSupplierInput(values: CreateSupplierForm): CreateSupplierInput {
  const days = orUndefined(values.paymentTermDays);
  return {
    name: values.name.trim(),
    displayName: orUndefined(values.displayName),
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
    notes: orUndefined(values.notes),
  };
}
