import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import type { Request } from 'express';
import { RequestContextService } from '#common/request-context/request-context.service.js';
import type { MobilePrincipal } from '#common/types/principal.js';
import { getRequestIp } from '#common/request-ip.js';
import '../rbac/resolved-store-context.js';

/**
 * Wraps every authenticated request in an AsyncLocalStorage context so that
 * RequestContextService.getUserId() / getRequestId() etc. work from anywhere
 * in the call stack without parameter threading.
 *
 * Runs AFTER guards (NestJS order: middleware → guards → interceptors), so
 * req.user is already populated by MobileJwtGuard when we get here.
 *
 * Unauthenticated routes (no req.user) are skipped gracefully.
 */
@Injectable()
export class RequestContextInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<Request>();
    const principal = req.user as MobilePrincipal | undefined;

    if (!principal) return next.handle();

    const storeContext = req.context;

    return new Observable((subscriber) => {
      RequestContextService.run(
        {
          user:      principal,
          requestId: (req.headers['x-request-id'] as string) ?? '',
          ip:        getRequestIp(req),
          userAgent: (req.headers['user-agent'] as string) ?? '',
          // storeId and accountId are attached by TenantGuard, which runs
          // before this interceptor. Must be forwarded, else getAccountId()
          // is always undefined.
          storeId:   storeContext?.storeId,
          accountId: storeContext?.accountId,
        },
        () => {
          next.handle().subscribe({
            next:     (v) => subscriber.next(v),
            error:    (e) => subscriber.error(e),
            complete: ()  => subscriber.complete(),
          });
        },
      );
    });
  }
}
