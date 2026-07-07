import { Injectable } from '@nestjs/common';
import axios from 'axios';
import { AppConfigService } from '#config/app-config.service.js';
import { AppException } from '#common/exceptions/app.exception.js';
import { ErrorCodes } from '#common/error-codes.js';

const MSG91_API = 'https://control.msg91.com/api/v5/otp';
const TIMEOUT_MS = 10_000;

@Injectable()
export class Msg91Service {
  constructor(private readonly config: AppConfigService) {}

  async sendOtp(phone: string, otp: string): Promise<void> {
    try {
      await axios.post(
        MSG91_API,
        {
          template_id: this.config.msg91TemplateId,
          mobile:      phone,
          otp,
        },
        {
          headers: { authkey: this.config.msg91AuthKey },
          timeout: TIMEOUT_MS,
        },
      );
    } catch {
      throw new AppException(
        ErrorCodes.INTERNAL_ERROR,
        'OTP_SEND_FAILED',
        500,
      );
    }
  }
}
