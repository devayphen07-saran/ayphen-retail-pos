import { router } from 'expo-router';
import { AmountInput, Input, RadioGroup } from '@ayphen/mobile-ui-components';
import { enqueueCreateCashMovement } from '@core/sync/mutations/enqueue-create-cash-movement';
import { useActiveStoreStore } from '@store';
import { FormScreen, FormFieldAnchor } from '../../../components/FormScreen';
import {
  createCashMovementSchema,
  DEFAULT_CREATE_CASH_MOVEMENT_VALUES,
  type CreateCashMovementForm,
} from '../types/schema';

const TYPE_OPTIONS = [
  { label: 'Cash in', value: 'payin' },
  { label: 'Cash out', value: 'payout' },
];

interface Props {
  accountId: string;
  accountGuuid: string;
  accountName: string;
}

/**
 * "Add transaction" (F4). Offline-first — enqueues locally and returns
 * immediately; the resulting `account_transactions` posting is server-derived
 * and arrives on the next sync (AccountDetailScreen shows this row as
 * "pending" in the meantime).
 */
export function CreateCashMovementScreen({ accountId, accountGuuid, accountName }: Props) {
  const storeId = useActiveStoreStore((s) => s.storeId) ?? '';

  return (
    <FormScreen<CreateCashMovementForm>
      schema={createCashMovementSchema}
      defaultValues={DEFAULT_CREATE_CASH_MOVEMENT_VALUES}
      title={`Add transaction · ${accountName}`}
      submitLabel="Save"
      fallbackError="Could not save the transaction."
      onSubmit={async (values) => {
        await enqueueCreateCashMovement(storeId, {
          accountId,
          accountGuuid,
          type: values.type,
          amountPaise: values.amountPaise as number, // schema guarantees non-null at this point
          reason: values.reason?.trim() || undefined,
        });
      }}
      onSuccess={() => router.back()}
    >
      {({ control, isSubmitting, submitOnLast, form, registerFieldOffset }) => (
        <>
          <RadioGroup<CreateCashMovementForm>
            name="type"
            control={control}
            options={TYPE_OPTIONS}
            label="Type"
            disabled={isSubmitting}
          />

          <AmountInput<CreateCashMovementForm>
            name="amountPaise"
            control={control}
            currency="INR"
            label="Amount"
            required
            disabled={isSubmitting}
          />

          <FormFieldAnchor name="reason" registerFieldOffset={registerFieldOffset}>
            <Input<CreateCashMovementForm>
              name="reason"
              control={control}
              label="Reason"
              placeholder={form.watch('type') === 'payout' ? 'Required for cash out' : 'Optional'}
              required={form.watch('type') === 'payout'}
              maxLength={280}
              disabled={isSubmitting}
              returnKeyType="done"
              onSubmitEditing={submitOnLast}
            />
          </FormFieldAnchor>
        </>
      )}
    </FormScreen>
  );
}