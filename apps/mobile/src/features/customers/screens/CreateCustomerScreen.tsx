import { router } from 'expo-router';
import { useWatch } from 'react-hook-form';
import { Input, Switch, Row, Column, Typography } from '@ayphen/mobile-ui-components';
import { useActiveStoreStore } from '@store';
import { enqueueCreateCustomer } from '@core/sync/mutations/enqueue-create-customer';
import {
  FormScreen,
  FormFieldAnchor,
  type FormScreenChildApi,
} from '../../../components/FormScreen';
import { AddressFields } from '../../../components/AddressFields';
import { useGstinPanAutofill } from '../../../utils/useGstinPanAutofill';
import {
  createCustomerSchema,
  DEFAULT_CREATE_CUSTOMER_VALUES,
  type CreateCustomerForm,
} from '../types/schema';
import { toCreateCustomerInput } from '../utils/transform';

/**
 * The form body, scoped so the name-gate `useWatch` (forms-agent §14) only
 * re-renders these fields — not the whole screen — on every keystroke.
 *
 * Form gate (BR-CUS-002): every field except the name stays disabled until the
 * name has 3+ characters. Clearing the name re-locks the fields but keeps their
 * values (we only toggle `disabled`, never reset).
 */
function CustomerFormFields({
  control,
  isSubmitting,
  submitOnLast,
  form,
  registerFieldOffset,
}: FormScreenChildApi<CreateCustomerForm>) {
  const nameValue = useWatch({ control, name: 'name' });
  const gateLocked = (nameValue ?? '').trim().length < 3;
  const fieldDisabled = isSubmitting || gateLocked;

  // BR-CUS-043 — auto-fill PAN from a valid GSTIN when PAN is empty.
  useGstinPanAutofill(form, 'gstNumber', 'panNumber');

  return (
    <>
      <FormFieldAnchor name="name" registerFieldOffset={registerFieldOffset}>
        <Input<CreateCustomerForm>
          name="name"
          control={control}
          label="Customer name"
          required
          autoFocus
          disabled={isSubmitting}
          returnKeyType="next"
          onSubmitEditing={() => form.setFocus('phone')}
        />
      </FormFieldAnchor>
      <FormFieldAnchor name="phone" registerFieldOffset={registerFieldOffset}>
        <Input<CreateCustomerForm>
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
        <Input<CreateCustomerForm>
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
        <Input<CreateCustomerForm>
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
        <Input<CreateCustomerForm>
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
        <Input<CreateCustomerForm>
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
        <Input<CreateCustomerForm>
          name="creditLimit"
          control={control}
          label="Credit limit (optional)"
          placeholder="e.g. 5000.00"
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
              Allow sales beyond the credit limit without a warning.
            </Typography.Caption>
          </Column>
          <Switch<CreateCustomerForm>
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
        <Input<CreateCustomerForm>
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
      <AddressFields<CreateCustomerForm>
        control={control}
        form={form}
        registerFieldOffset={registerFieldOffset}
        disabled={fieldDisabled}
        onPinSubmit={() => form.setFocus('notes')}
      />
      <FormFieldAnchor name="notes" registerFieldOffset={registerFieldOffset}>
        <Input<CreateCustomerForm>
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
 * Create a customer — offline-first: this enqueues a local write + a queued
 * mutation (enqueue-create-customer.ts) instead of an HTTP request. Like
 * CreateProductScreen, there is no server round trip to await, so `onSubmit`
 * can't fail with a server error code — the apply/reject happens later off the
 * sync queue.
 */
export function CreateCustomerScreen() {
  const storeId = useActiveStoreStore((s) => s.storeId) ?? '';

  return (
    <FormScreen<CreateCustomerForm>
      schema={createCustomerSchema}
      defaultValues={DEFAULT_CREATE_CUSTOMER_VALUES}
      title="New Customer"
      submitLabel="Create"
      fallbackError="Could not create the customer."
      onSubmit={async (values) => {
        await enqueueCreateCustomer(storeId, toCreateCustomerInput(values));
      }}
      onSuccess={() => router.back()}
    >
      {(api) => <CustomerFormFields {...api} />}
    </FormScreen>
  );
}
