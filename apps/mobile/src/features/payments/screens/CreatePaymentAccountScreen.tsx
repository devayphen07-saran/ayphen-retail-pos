import { router } from 'expo-router';
import { Input, Switch, Typography } from '@ayphen/mobile-ui-components';
import { useCreatePaymentAccountMutation } from '@ayphen/api-manager';
import { requestImmediateSync } from '@core/sync/scheduler-instance';
import { useActiveStoreStore } from '@store';
import { FormScreen, FormFieldAnchor } from '../../../components/FormScreen';
import { PaymentKindSelect } from '../components/PaymentKindSelect';
import {
  createPaymentAccountSchema,
  DEFAULT_CREATE_PAYMENT_ACCOUNT_VALUES,
  type CreatePaymentAccountForm,
} from '../types/schema';
import { toCreatePaymentAccountBody } from '../utils/transform';
import { referenceFieldCopy } from '../utils/reference-copy';

/**
 * Create a payment account — ONLINE (REST). On success we kick an immediate sync
 * pull so the offline checkout cache picks up the new account too (the server
 * write bumped its row_version/modified_at). Errors surface via FormScreen's
 * thrown-error path (duplicate name → inline on the name field).
 */
export function CreatePaymentAccountScreen() {
  const storeId = useActiveStoreStore((s) => s.storeId) ?? '';
  const createMutation = useCreatePaymentAccountMutation(storeId);

  return (
    <FormScreen<CreatePaymentAccountForm>
      schema={createPaymentAccountSchema}
      defaultValues={DEFAULT_CREATE_PAYMENT_ACCOUNT_VALUES}
      title="New payment account"
      submitLabel="Create"
      fallbackError="Could not create the payment account."
      mapError={(err, setError) => {
        const code = String(
          (err as { code?: string; errorCode?: string })?.code ??
            (err as { errorCode?: string })?.errorCode ??
            '',
        ).toLowerCase();
        if (code === 'duplicate_entry') {
          setError('name', { type: 'server', message: 'An account with this name already exists.' });
          return true;
        }
        return false;
      }}
      onSubmit={async (values) => {
        await createMutation.mutateAsync({
          pathParam: { storeId },
          bodyParam: toCreatePaymentAccountBody(values),
        });
      }}
      onSuccess={() => {
        // Refresh the offline cache (checkout) with the newly-created account.
        requestImmediateSync();
        router.back();
      }}
    >
      {({ control, isSubmitting, submitOnLast, form, registerFieldOffset }) => (
        <>
          <FormFieldAnchor name="name" registerFieldOffset={registerFieldOffset}>
            <Input<CreatePaymentAccountForm>
              name="name"
              control={control}
              label="Account name"
              placeholder="e.g. HDFC Current, PhonePe"
              required
              autoFocus
              disabled={isSubmitting}
              returnKeyType="done"
              onSubmitEditing={submitOnLast}
            />
          </FormFieldAnchor>

          <PaymentKindSelect
            value={form.watch('kind')}
            onChange={(kind) => form.setValue('kind', kind, { shouldDirty: true })}
            disabled={isSubmitting}
          />

          {(() => {
            const copy = referenceFieldCopy(form.watch('kind'));
            return (
              <>
                <Input<CreatePaymentAccountForm>
                  name="reference"
                  control={control}
                  label={copy.label}
                  placeholder={copy.placeholder}
                  maxLength={140}
                  disabled={isSubmitting}
                />
                <Typography.Caption>
                  Optional — for your reference. Don&apos;t enter card CVV, PINs, or full card
                  numbers.
                </Typography.Caption>
              </>
            );
          })()}

          <Switch<CreatePaymentAccountForm>
            name="setDefault"
            control={control}
            label="Set as default"
            disabled={isSubmitting}
          />
        </>
      )}
    </FormScreen>
  );
}
