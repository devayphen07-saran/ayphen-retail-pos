import { router } from 'expo-router';
import { Input, Switch } from '@ayphen/mobile-ui-components';
import { useActiveStoreStore } from '@store';
import { enqueueCreateProduct } from '@core/sync/mutations/enqueue-create-product';
import { FormScreen, FormFieldAnchor } from '../../../components/FormScreen';
import {
  createProductSchema,
  DEFAULT_CREATE_PRODUCT_VALUES,
  type CreateProductForm,
} from '../types/schema';
import { toCreateProductInput } from '../utils/transform';

/**
 * Create a product — offline-first: this enqueues a local write + a queued
 * mutation (enqueue-create-product.ts) instead of an HTTP request. There is
 * no server round trip to await here, so unlike every other FormScreen in
 * this app, `onSubmit` can't fail with a server error code — the actual
 * apply/reject happens later, asynchronously, off the sync queue.
 */
export function CreateProductScreen() {
  const storeId = useActiveStoreStore((s) => s.storeId) ?? '';

  return (
    <FormScreen<CreateProductForm>
      schema={createProductSchema}
      defaultValues={DEFAULT_CREATE_PRODUCT_VALUES}
      title="New Product"
      submitLabel="Create"
      fallbackError="Could not create the product."
      onSubmit={async (values) => {
        await enqueueCreateProduct(storeId, toCreateProductInput(values));
      }}
      onSuccess={() => router.back()}
    >
      {({ control, isSubmitting, submitOnLast, form, registerFieldOffset }) => (
        <>
          <FormFieldAnchor name="name" registerFieldOffset={registerFieldOffset}>
            <Input<CreateProductForm>
              name="name"
              control={control}
              label="Product name"
              required
              autoFocus
              disabled={isSubmitting}
              returnKeyType="next"
              onSubmitEditing={() => form.setFocus('sellingPrice')}
            />
          </FormFieldAnchor>
          <FormFieldAnchor name="sellingPrice" registerFieldOffset={registerFieldOffset}>
            <Input<CreateProductForm>
              name="sellingPrice"
              control={control}
              label="Selling price"
              placeholder="e.g. 199.00"
              keyboardType="decimal-pad"
              required
              disabled={isSubmitting}
              returnKeyType="next"
              onSubmitEditing={() => form.setFocus('costPrice')}
            />
          </FormFieldAnchor>
          <FormFieldAnchor name="costPrice" registerFieldOffset={registerFieldOffset}>
            <Input<CreateProductForm>
              name="costPrice"
              control={control}
              label="Cost price (optional)"
              placeholder="e.g. 120.00"
              keyboardType="decimal-pad"
              disabled={isSubmitting}
              returnKeyType="next"
              onSubmitEditing={() => form.setFocus('mrp')}
            />
          </FormFieldAnchor>
          <FormFieldAnchor name="mrp" registerFieldOffset={registerFieldOffset}>
            <Input<CreateProductForm>
              name="mrp"
              control={control}
              label="MRP (optional)"
              placeholder="e.g. 249.00"
              keyboardType="decimal-pad"
              disabled={isSubmitting}
              returnKeyType="next"
              onSubmitEditing={() => form.setFocus('sku')}
            />
          </FormFieldAnchor>
          <FormFieldAnchor name="sku" registerFieldOffset={registerFieldOffset}>
            <Input<CreateProductForm>
              name="sku"
              control={control}
              label="SKU (optional)"
              disabled={isSubmitting}
              returnKeyType="next"
              onSubmitEditing={() => form.setFocus('barcode')}
            />
          </FormFieldAnchor>
          <FormFieldAnchor name="barcode" registerFieldOffset={registerFieldOffset}>
            <Input<CreateProductForm>
              name="barcode"
              control={control}
              label="Barcode (optional)"
              disabled={isSubmitting}
              returnKeyType="done"
              onSubmitEditing={submitOnLast}
            />
          </FormFieldAnchor>
          <Switch<CreateProductForm>
            name="trackInventory"
            control={control}
            label="Track inventory"
            disabled={isSubmitting}
          />
        </>
      )}
    </FormScreen>
  );
}
