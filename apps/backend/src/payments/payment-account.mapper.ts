import type { PaymentAccountRow } from './types/payment-account.types.js';
import type { PaymentAccountResponse } from './dto/payment-account.response.js';

export const PaymentAccountMapper = {
  toResponse(row: PaymentAccountRow): PaymentAccountResponse {
    return {
      guuid: row.guuid,
      name: row.name,
      kind: row.kind,
      details: row.details ?? null,
      is_default: row.isDefault,
      is_active: row.isActive,
      is_system: row.isSystem,
      system_key: row.systemKey ?? null,
      row_version: row.rowVersion,
    };
  },
  toListResponse(rows: PaymentAccountRow[]): PaymentAccountResponse[] {
    return rows.map((r) => this.toResponse(r));
  },
};
