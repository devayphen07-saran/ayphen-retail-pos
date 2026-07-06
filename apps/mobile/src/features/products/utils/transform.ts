import type { CreateProductInput } from '@core/sync/mutations/enqueue-create-product';
import type { CreateProductForm } from '../types/schema';

const orUndefined = (v: string | undefined) => (v && v.trim().length > 0 ? v.trim() : undefined);

/** Pure form → enqueueCreateProduct's input shape. */
export function toCreateProductInput(values: CreateProductForm): CreateProductInput {
  return {
    name: values.name.trim(),
    sku: orUndefined(values.sku),
    barcode: orUndefined(values.barcode),
    sellingPrice: values.sellingPrice.trim(),
    costPrice: orUndefined(values.costPrice),
    mrp: orUndefined(values.mrp),
    trackInventory: values.trackInventory,
  };
}
