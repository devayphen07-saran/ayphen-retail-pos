import {
  Controller,
  ForbiddenException,
  HttpCode,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '#common/rbac/decorators/rbac.decorators.js';
import { BillingService } from './billing.service.js';

/**
 * Razorpay webhook — the authoritative payment backstop (subscription §9). No
 * JWT, no step-up: it is server-to-server and authenticated ONLY by the
 * X-Razorpay-Signature HMAC over the raw body (captured in apply-global-config
 * via the json body-parser `verify` hook). Per-provider route by design.
 */
@Controller('webhooks')
export class RazorpayWebhookController {
  constructor(private readonly billing: BillingService) {}

  @Post('razorpay')
  @Public()
  @HttpCode(200)
  async handle(@Req() req: Request & { rawBody?: Buffer }): Promise<{ handled: boolean }> {
    const signature = req.headers['x-razorpay-signature'];
    const rawBody = req.rawBody;
    if (!rawBody || typeof signature !== 'string') {
      throw new ForbiddenException('WEBHOOK_SIGNATURE_INVALID');
    }
    return this.billing.handleWebhook(rawBody, signature);
  }
}
