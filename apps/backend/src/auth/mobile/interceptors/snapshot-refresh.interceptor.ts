import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { from, Observable } from 'rxjs';
import { switchMap } from 'rxjs/operators';
import type { Request, Response } from 'express';
import { RequestContextService } from '#common/request-context/request-context.service.js';
import { SnapshotService } from '../services/snapshot.service.js';
import type { MobilePrincipal } from '#common/types/principal.js';

@Injectable()
export class SnapshotRefreshInterceptor implements NestInterceptor {
  constructor(
    private readonly reqCtx: RequestContextService,
    private readonly snapshot: SnapshotService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<Request>();
    const res = context.switchToHttp().getResponse<Response>();
    const principal = req.user as MobilePrincipal | undefined;

    if (!principal) return next.handle();

    // Wrap the whole pipeline in the request context. switchMap(() => from(promise))
    // makes the async transform part of the stream, so completion waits for the
    // Promise to resolve — unlike map(async …), which emits pending Promises and
    // can be beaten to complete() by a synchronously-completing source (dropping
    // the body).
    return this.reqCtx.run(principal, () =>
      next.handle().pipe(
        switchMap((data: unknown) => from(this.enrich(data, req, res, principal))),
      ),
    );
  }

  private async enrich(
    data: unknown,
    req: Request,
    res: Response,
    principal: MobilePrincipal,
  ): Promise<unknown> {
    res.setHeader(
      'X-Permissions-Version',
      String(principal.permissionsVersion),
    );

    const clientVersion = req.headers['x-snapshot-version']
      ? Number(req.headers['x-snapshot-version'])
      : undefined;

    const snapshotResult = await this.snapshot.getOrBuild(
      principal.userId,
      clientVersion,
    );

    const isPlainObject =
      typeof data === 'object' && data !== null && !Array.isArray(data);

    if (!isPlainObject) return data;

    if (snapshotResult) {
      return {
        ...(data as Record<string, unknown>),
        snapshot: snapshotResult.snapshot,
        snapshot_signature: snapshotResult.signature,
        snapshot_changed: true,
      };
    }

    return {
      ...(data as Record<string, unknown>),
      snapshot_changed: false,
    };
  }
}