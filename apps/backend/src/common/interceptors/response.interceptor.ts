import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { Response, Request } from 'express';
import { RESPONSE_MESSAGE_KEY } from '../decorators/response-message.decorator';
import { SKIP_TRANSFORM_KEY } from '../decorators/skip-transform.decorator';

export interface ApiEnvelope<T> {
  success:    boolean;
  statusCode: number;
  message:    string;
  data:       T | null;
  requestId:  string;
  timestamp:  string;
}

@Injectable()
export class ResponseInterceptor<T>
  implements NestInterceptor<T, ApiEnvelope<T> | T>
{
  constructor(private readonly reflector: Reflector) {}

  intercept(
    context: ExecutionContext,
    next: CallHandler<T>,
  ): Observable<ApiEnvelope<T> | T> {
    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_TRANSFORM_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skip) return next.handle();

    return next.handle().pipe(
      map((data) => {
        const ctx      = context.switchToHttp();
        const response = ctx.getResponse<Response>();
        const request  = ctx.getRequest<Request>();

        const statusCode = response.statusCode;
        const message    =
          this.reflector.getAllAndOverride<string>(RESPONSE_MESSAGE_KEY, [
            context.getHandler(),
            context.getClass(),
          ]) ?? 'Success';

        return {
          success:    true,
          statusCode,
          message,
          data:       data ?? null,
          requestId:  request.headers['x-request-id'] as string,
          timestamp:  new Date().toISOString(),
        };
      }),
    );
  }
}
