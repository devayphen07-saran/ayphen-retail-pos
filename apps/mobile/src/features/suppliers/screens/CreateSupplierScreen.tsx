import { router } from 'expo-router';
import { useWatch } from 'react-hook-form';
import { Input, Switch, Row, Column, Typography } from '@ayphen/mobile-ui-components';
import { useActiveStoreStore } from '@store';
import { enqueueCreateSupplier } from '@core/sync/mutations/enqueue-create-supplier';
import {
  FormScreen,
  FormFieldAnchor,
  type FormScreenChildApi,
} from '../../../components/FormScreen';
import { AddressFields } from '../../../components/AddressFields';
import { useGstinPanAutofill } from '../../../utils/useGstinPanAutofill';
import {
  createSupplierSchema,
  DEFAULT_CREATE_SUPPLIER_VALUES,
  type CreateSupplierForm,
} from '../types/schema';
import { toCreateSupplierInput } from '../utils/transform';

/**
 * The form body, scoped so the name-gate `useWatch` (forms-agent §14) only
 * re-renders these fields on each keystroke. Form gate (BR-SUP-002): every
 * field except the name stays disabled until the name has 3+ characters.
 */
function SupplierFormFields({
  control,
  isSubmitting,
  submitOnLast,
  form,
  registerFieldOffset,
}: FormScreenChildApi<CreateSupplierForm>) {
  const nameValue = useWatch({ control, name: 'name' });
  const gateLocked = (nameValue ?? '').trim().length < 3;
  const fieldDisabled = isSubmitting || gateLocked;

  // BR-SUP-014 — auto-fill PAN from a valid GSTIN when PAN is empty.
  useGstinPanAutofill(form, 'gstNumber', 'panNumber');

  return (
    <>
      <FormFieldAnchor name="name" registerFieldOffset={registerFieldOffset}>
        <Input<CreateSupplierForm>
          name="name"
          control={control}
          label="Supplier name"
          required
          autoFocus
          disabled={isSubmitting}
          returnKeyType="next"
          onSubmitEditing={() => form.setFocus('displayName')}
        />
      </FormFieldAnchor>
      <FormFieldAnchor name="displayName" registerFieldOffset={registerFieldOffset}>
        <Input<CreateSupplierForm>
          name="displayName"
          control={control}
          label="Display name (optional)"
          placeholder="e.g. HUL"
          disabled={fieldDisabled}
          returnKeyType="next"
          onSubmitEditing={() => form.setFocus('phone')}
        />
      </FormFieldAnchor>
      <FormFieldAnchor name="phone" registerFieldOffset={registerFieldOffset}>
        <Input<CreateSupplierForm>
          name="phone"
          control={control}
          label="Phone (optional)"
          keyboardType="phone-pad"
          disabled={fieldDisabled}
          returnKeyType="next"
          onSubmitEditing={() => form.setFocus('email')}
        />
      </FormFieldAnchor>
      <FormFieldAnchor name="email" registerFieldOffset={registerFieldOffset}>
        <Input<CreateSupplierForm>
          name="email"
          control={control}
          label="Email (optional)"
          keyboardType="email-address"
          autoCapitalize="none"
          disabled={fieldDisabled}
          returnKeyType="next"
          onSubmitEditing={() => form.setFocus('website')}
        />
      </FormFieldAnchor>
      <FormFieldAnchor name="website" registerFieldOffset={registerFieldOffset}>
        <Input<CreateSupplierForm>
          name="website"
          control={control}
          label="Website (optional)"
          keyboardType="url"
          autoCapitalize="none"
          disabled={fieldDisabled}
          returnKeyType="next"
          onSubmitEditing={() => form.setFocus('gstNumber')}
        />
      </FormFieldAnchor>
      <FormFieldAnchor name="gstNumber" registerFieldOffset={registerFieldOffset}>
        <Input<CreateSupplierForm>
          name="gstNumber"
          control={control}
          label="GST number (optional)"
          autoCapitalize="characters"
          disabled={fieldDisabled}
          returnKeyType="next"
          onSubmitEditing={() => form.setFocus('panNumber')}
        />
      </FormFieldAnchor>
      <FormFieldAnchor name="panNumber" registerFieldOffset={registerFieldOffset}>
        <Input<CreateSupplierForm>
          name="panNumber"
          control={control}
          label="PAN (optional)"
          autoCapitalize="characters"
          disabled={fieldDisabled}
          returnKeyType="next"
          onSubmitEditing={() => form.setFocus('creditLimit')}
        />
      </FormFieldAnchor>
      <FormFieldAnchor name="creditLimit" registerFieldOffset={registerFieldOffset}>
        <Input<CreateSupplierForm>
          name="creditLimit"
          control={control}
          label="Credit limit (optional)"
          placeholder="e.g. 50000.00"
          keyboardType="decimal-pad"
          disabled={fieldDisabled}
          returnKeyType="next"
          onSubmitEditing={() => form.setFocus('paymentTermDays')}
        />
      </FormFieldAnchor>
      <FormFieldAnchor
        name="overrideCreditLimit"
        registerFieldOffset={registerFieldOffset}
      >
        <Row align="center" justify="space-between">
          <Column flex={1}>
            <Typography.Body weight="semiBold">
              Override credit limit
            </Typography.Body>
            <Typography.Caption>
              Allow purchases beyond the credit limit without a warning.
            </Typography.Caption>
          </Column>
          <Switch<CreateSupplierForm>
            name="overrideCreditLimit"
            control={control}
            disabled={fieldDisabled}
          />
        </Row>
      </FormFieldAnchor>
      <FormFieldAnchor
        name="paymentTermDays"
        registerFieldOffset={registerFieldOffset}
      >
        <Input<CreateSupplierForm>
          name="paymentTermDays"
          control={control}
          label="Payment term days (optional)"
          placeholder="e.g. 30"
          keyboardType="number-pad"
          disabled={fieldDisabled}
          returnKeyType="next"
          onSubmitEditing={() => form.setFocus('addressLine1')}
        />
      </FormFieldAnchor>
      <AddressFields<CreateSupplierForm>
        control={control}
        form={form}
        registerFieldOffset={registerFieldOffset}
        disabled={fieldDisabled}
        onPinSubmit={() => form.setFocus('notes')}
      />
      <FormFieldAnchor name="notes" registerFieldOffset={registerFieldOffset}>
        <Input<CreateSupplierForm>
          name="notes"
          control={control}
          label="Notes (optional)"
          multiline
          disabled={fieldDisabled}
          returnKeyType="done"
          onSubmitEditing={submitOnLast}
        />
      </FormFieldAnchor>
    </>
  );
}

/**
 * Create a supplier — offline-first: enqueues a local write + a queued mutation
 * (enqueue-create-supplier.ts) instead of an HTTP request. Like the other
 * offline create forms, `onSubmit` can't fail with a server error code — the
 * apply/reject happens later off the sync queue.
 */
export function CreateSupplierScreen() {
  const storeId = useActiveStoreStore((s) => s.storeId) ?? '';

  return (
    <FormScreen<CreateSupplierForm>
      schema={createSupplierSchema}
      defaultValues={DEFAULT_CREATE_SUPPLIER_VALUES}
      title="New Supplier"
      submitLabel="Create"
      fallbackError="Could not create the supplier."
      onSubmit={async (values) => {
        await enqueueCreateSupplier(storeId, toCreateSupplierInput(values));
      }}
      onSuccess={() => router.back()}
    >
      {(api) => <SupplierFormFields {...api} />}
    </FormScreen>
  );
}
