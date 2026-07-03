import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import type { Request } from 'express';
import { RequestContextService } from '#auth/core/request-context.service.js';
import type { MobilePrincipal } from '#auth/mobile/types/mobile-principal.js';
import '../../auth/mobile/types/store-context.js';
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

    // TenantGuard writes req.context; legacy StoreGuard writes req.storeContext.
    const storeContext = req.context ?? req.storeContext;

    return new Observable((subscriber) => {
      RequestContextService.run(
        {
          user:      principal,
          requestId: (req.headers['x-request-id'] as string) ?? '',
          ip:        (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
                       ?? req.socket?.remoteAddress
                       ?? '',
          userAgent: (req.headers['user-agent'] as string) ?? '',
          // storeId and accountId are attached by TenantGuard (or legacy
          // StoreGuard), both of which run before this interceptor. Must be
          // forwarded, else getAccountId() is always undefined.
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
