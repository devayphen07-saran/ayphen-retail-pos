import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import { AppConfigService } from '#config/app-config.service.js';
import { UnprocessableError } from '#common/exceptions/app.exception.js';
import { ErrorCodes } from '#common/error-codes.js';

const ARGON2_OPTIONS: argon2.Options = {
  type:        argon2.argon2id,
  memoryCost:  65536, // 64 KB
  timeCost:    3,
  parallelism: 4,
};

@Injectable()
export class PasswordService {
  constructor(private readonly config: AppConfigService) {}

  async hash(password: string): Promise<string> {
    this.assertLength(password);
    return argon2.hash(password, ARGON2_OPTIONS);
  }

  async verify(hash: string, password: string): Promise<boolean> {
    this.assertLength(password);
    try {
      return await argon2.verify(hash, password);
    } catch {
      return false;
    }
  }

  needsRehash(hash: string): boolean {
    return argon2.needsRehash(hash, ARGON2_OPTIONS);
  }

  private assertLength(password: string): void {
    if (password.length > this.config.maxPasswordLength) {
      throw new UnprocessableError(ErrorCodes.PASSWORD_TOO_LONG, 'Password exceeds maximum allowed length');
    }
  }
}
