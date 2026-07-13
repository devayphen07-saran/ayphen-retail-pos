import type {
  CreatePaymentAccountDto,
  UpdatePaymentAccountDto,
} from './dto/payment-account.dto.js';
import type {
  CreatePaymentAccountInput,
  UpdatePaymentAccountInput,
} from './types/payment-account.types.js';

/**
 * The only inbound translation point for payment-account writes: snake_case wire
 * DTO → camelCase domain input. Pure, no DI, no async — symmetric with
 * `PaymentAccountMapper` on the way out. Keeps the service DTO-free so it speaks
 * camelCase only (§3.3).
 */
export const PaymentAccountRequestMapper = {
  toCreateInput(dto: CreatePaymentAccountDto): CreatePaymentAccountInput {
    return {
      name: dto.name,
      kind: dto.kind,
      details: dto.details,
      isDefault: dto.is_default,
    };
  },

  toUpdateInput(dto: UpdatePaymentAccountDto): UpdatePaymentAccountInput {
    return {
      name: dto.name,
      kind: dto.kind,
      details: dto.details,
      isDefault: dto.is_default,
      isActive: dto.is_active,
      expectedRowVersion: dto.expected_row_version,
    };
  },
};