import {
  Controller,
  HttpCode,
  Post,
  Req,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request } from 'express';
import { ForbiddenError } from '#common/exceptions/app.exception.js';
import { ErrorCodes } from '#common/error-codes.js';
import { Public } from '#common/rbac/decorators/rbac.decorators.js';
import { BillingService } from './billing.service.js';
import { SubscriptionResponseMapper } from './subscription.mapper.js';
import type { WebhookResponse } from './dto/checkout.response.js';

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
  @SkipThrottle()
  @HttpCode(200)
  async handle(@Req() req: Request & { rawBody?: Buffer }): Promise<WebhookResponse> {
    const signature = req.headers['x-razorpay-signature'];
    const rawBody = req.rawBody;
    if (!rawBody || typeof signature !== 'string') {
      throw new ForbiddenError(ErrorCodes.WEBHOOK_SIGNATURE_INVALID, 'Webhook signature is invalid');
    }
    await this.billing.handleWebhook(rawBody, signature);
    return SubscriptionResponseMapper.toWebhookResponse();
  }
}
