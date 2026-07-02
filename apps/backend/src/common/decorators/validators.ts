import {
  registerDecorator,
  ValidationOptions,
  ValidationArguments,
  buildMessage,
} from 'class-validator';

// ─── Price ────────────────────────────────────────────────────────────────────
// Valid POS price: integer paise (0–99_999_99 = ₹9,99,999.99), no decimals.

export function IsValidPrice(options?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isValidPrice',
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate(value: unknown) {
          return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 9_999_999;
        },
        defaultMessage: buildMessage(
          (each) => each + '$property must be a non-negative integer in paise (≤ ₹99,999.99)',
          options,
        ),
      },
    });
  };
}

// ─── SKU ─────────────────────────────────────────────────────────────────────
// Alphanumeric + hyphens/underscores, 1–64 chars.

const SKU_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function IsValidSku(options?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isValidSku',
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate(value: unknown) {
          return typeof value === 'string' && SKU_RE.test(value);
        },
        defaultMessage: buildMessage(
          (each) => each + '$property must be 1–64 alphanumeric characters, hyphens, or underscores',
          options,
        ),
      },
    });
  };
}

// ─── Positive integer ─────────────────────────────────────────────────────────

export function IsPositiveInteger(options?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isPositiveInteger',
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate(value: unknown) {
          return Number.isInteger(value) && (value as number) > 0;
        },
        defaultMessage: buildMessage(
          (each) => each + '$property must be a positive integer',
          options,
        ),
      },
    });
  };
}

// ─── Non-negative integer ─────────────────────────────────────────────────────

export function IsNonNegativeInteger(options?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isNonNegativeInteger',
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate(value: unknown) {
          return Number.isInteger(value) && (value as number) >= 0;
        },
        defaultMessage: buildMessage(
          (each) => each + '$property must be a non-negative integer',
          options,
        ),
      },
    });
  };
}

// ─── Indian phone ─────────────────────────────────────────────────────────────
// E.164 Indian numbers: +91 followed by 10 digits starting with 6-9.

const INDIAN_PHONE_RE = /^\+91[6-9]\d{9}$/;

export function IsIndianPhone(options?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isIndianPhone',
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate(value: unknown) {
          return typeof value === 'string' && INDIAN_PHONE_RE.test(value);
        },
        defaultMessage: buildMessage(
          (each) => each + '$property must be a valid Indian mobile number (+91XXXXXXXXXX)',
          options,
        ),
      },
    });
  };
}

// ─── GST number ───────────────────────────────────────────────────────────────
// Standard 15-char GSTIN format: 2-digit state code + 10-char PAN + 1 entity + Z + checksum.

const GST_RE = /^[0-3][0-9][A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

export function IsGstNumber(options?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isGstNumber',
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate(value: unknown) {
          return typeof value === 'string' && GST_RE.test(value);
        },
        defaultMessage: buildMessage(
          (each) => each + '$property must be a valid 15-character GSTIN',
          options,
        ),
      },
    });
  };
}

// ─── Trimmed non-empty string ─────────────────────────────────────────────────
// Rejects strings that are empty or whitespace-only after trimming.
// Use alongside @IsString() so type is already guaranteed.

export function IsTrimmedNonEmpty(options?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isTrimmedNonEmpty',
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate(value: unknown, _args: ValidationArguments) {
          return typeof value === 'string' && value.trim().length > 0;
        },
        defaultMessage: buildMessage(
          (each) => each + '$property must not be empty or whitespace-only',
          options,
        ),
      },
    });
  };
}
