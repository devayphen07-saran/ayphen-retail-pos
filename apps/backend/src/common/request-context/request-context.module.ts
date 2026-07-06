import { Global, Module } from '@nestjs/common';
import { RequestContextService } from './request-context.service.js';

/** AsyncLocalStorage-backed request context, shared app-wide (guards populate it, interceptors/services read it). */
@Global()
@Module({
  providers: [RequestContextService],
  exports: [RequestContextService],
})
export class RequestContextModule {}
