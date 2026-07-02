import { Injectable } from '@nestjs/common';
import { AppException } from '../../common/exceptions/app.exception.js';
import { ErrorCodes } from '../../common/error-codes.js';
import { RateLimitRepository } from './rate-limit.repository.js';
import { AuthConstantsService } from './auth-constants.service.js';

@Injectable()
export class RateLimitService {
  constructor(
    private readonly repo:      RateLimitRepository,
    private readonly constants: AuthConstantsService,
  ) {}

  async checkIpLimit(ip: string): Promise<void> {
    const count = await this.repo.countIpAttempts(ip);
    if (count >= 5) {
      throw new AppException(
        ErrorCodes.RATE_LIMIT_EXCEEDED,
        'Too many requests from this IP — please wait before retrying',
        429,
      );
    }
  }

  async checkAccountLimit(userId: string): Promise<void> {
    const count = await this.repo.countAccountFailures(userId);
    if (count >= 10) {
      throw new AppException(
        ErrorCodes.ACCOUNT_LOCKED,
        'Account temporarily locked due to too many failed attempts',
        429,
      );
    }
  }

  async checkEmailLimit(email: string): Promise<void> {
    const count = await this.repo.countEmailAttempts(email);
    if (count >= 5) {
      throw new AppException(
        ErrorCodes.RATE_LIMIT_EXCEEDED,
        'Too many attempts for this email — please wait before retrying',
        429,
      );
    }
  }

  async checkPhoneOtpLimit(phone: string): Promise<void> {
    const count = await this.repo.countPhoneOtpAttempts(phone);
    if (count >= this.constants.OTP_MAX_ATTEMPTS) {
      throw new AppException(
        ErrorCodes.RATE_LIMIT_EXCEEDED,
        'Too many OTP requests for this phone — please wait before retrying',
        429,
      );
    }
  }

  async recordAttempt(entry: {
    ip:      string;
    userId?: string;
    email?:  string;
    phone?:  string;
    purpose: string;
    success: boolean;
  }): Promise<void> {
    await this.repo.insert(entry);
  }
}
