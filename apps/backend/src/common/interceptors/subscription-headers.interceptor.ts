import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { tap } from 'rxjs/operators';
import type { Observable } from 'rxjs';
import type { Request, Response } from 'express';

/**
 * Emits subscription freshness headers so the client keeps its cached
 * `access_valid_until` / plan state current without a dedicated fetch
 * (subscription §19; device §30.5 depends on the warning header):
 *
 *   X-Subscription-Version: <n>
 *   X-Subscription-Warning: past_due:grace_until_<ISO>   (only when applicable)
 *
 * The values come from `req.subscriptionFreshness`, stamped by
 * SubscriptionStatusGuard. Routes that don't run that guard emit no headers —
 * which is correct: they carry no resolved account context.
 *
 * Headers are written before the handler emits (guards run before
 * interceptors), so they land on the response regardless of the body.
 */
@Injectable()
export class SubscriptionHeadersInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req  = http.getRequest<Request>();
    const res  = http.getResponse<Response>();

    const setHeaders = () => {
      const freshness = req.subscriptionFreshness;
      if (!freshness || res.headersSent) return;
      res.setHeader('X-Subscription-Version', String(freshness.version));
      if (freshness.warning) {
        res.setHeader('X-Subscription-Warning', freshness.warning);
      }
    };

    // Set eagerly (covers the streamed-success path) and again on completion as
    // a backstop in case the guard populated freshness asynchronously.
    setHeaders();
    return next.handle().pipe(tap({ next: setHeaders }));
  }
}
