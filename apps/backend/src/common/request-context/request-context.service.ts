import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'async_hooks';
import type { MobilePrincipal } from '../types/principal.js';

export interface RequestContext {
  user:        MobilePrincipal;
  requestId:   string;
  ip:          string;
  userAgent:   string;
  storeId?:    string;
  accountId?:  string;
}

const storage = new AsyncLocalStorage<RequestContext>();

@Injectable()
export class RequestContextService {
  /** Wrap fn in an async context. Guards populate req.user first; this runs in interceptors. */
  static run<T>(ctx: RequestContext, fn: () => T): T {
    return storage.run(ctx, fn);
  }

  /** @deprecated Use static run() — instance method kept for SnapshotRefreshInterceptor compat. */
  run<T>(principal: MobilePrincipal, fn: () => T): T {
    const existing = storage.getStore();
    const ctx: RequestContext = existing
      ? { ...existing, user: principal }
      : { user: principal, requestId: '', ip: '', userAgent: '' };
    return storage.run(ctx, fn);
  }

  getContext():   RequestContext | undefined { return storage.getStore(); }
  get():          MobilePrincipal | undefined { return storage.getStore()?.user; }
  getOrThrow():   MobilePrincipal {
    const ctx = storage.getStore();
    if (!ctx) throw new Error('No request context — called outside a request scope');
    return ctx.user;
  }

  getUserId():    string | undefined { return storage.getStore()?.user?.userId; }
  getAccountId(): string | undefined { return storage.getStore()?.accountId; }
  getStoreId():   string | undefined { return storage.getStore()?.storeId; }
  getRequestId(): string | undefined { return storage.getStore()?.requestId; }
  getIp():        string | undefined { return storage.getStore()?.ip; }
  getUserAgent(): string | undefined { return storage.getStore()?.userAgent; }
}
