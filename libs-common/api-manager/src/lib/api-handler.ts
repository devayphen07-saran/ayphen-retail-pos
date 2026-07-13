import { isAxiosError } from 'axios';
import type {
  AxiosError,
  AxiosRequestConfig,
  AxiosResponse,
  RawAxiosRequestHeaders,
} from 'axios';
import type {
  QueryKey,
  UseMutationOptions,
  UseQueryOptions,
} from '@tanstack/react-query';
import { API } from './axios-instances';

export enum APIMethod {
  POST = 'post',
  GET = 'get',
  PUT = 'put',
  DELETE = 'delete',
  PATCH = 'patch',
}

type PathRecord = Record<string, string | number | undefined | null>;

type QueryPrimitive = string | number | boolean | undefined | null;

type QueryRecord = Record<string, QueryPrimitive | QueryPrimitive[]>;

type HeaderBag = RawAxiosRequestHeaders & {
  delete?: (name: string) => void;
  set?: (name: string, value: string | number | boolean) => void;
};

type ApiErrorBody = {
  error?: {
    errorCode?: string;
    code?: string;
    message?: string;
    issues?: ZodIssueLike[];
    details?: { fieldErrors?: Record<string, string> };
  };
  errorCode?: string;
  code?: string;
  message?: string;
  issues?: ZodIssueLike[];
  details?: { fieldErrors?: Record<string, string> };
};

type ZodIssueLike = {
  path: (string | number)[];
  message: string;
};

export interface NormalizedError {
  status: number;
  code: string;
  message: string;
  isOffline: boolean;
  data?: unknown;

  /** Per-field validation messages, keyed by field path, e.g. "name". */
  fieldErrors?: Record<string, string>;
}

export interface RequestParams<T> {
  bodyParam?: T;
  queryParam?: string | URLSearchParams | QueryRecord;
  pathParam?: PathRecord;
}

/**
 * Variables for a multipart upload mutation.
 *
 * The caller owns building FormData. This wrapper only resolves path/query
 * params, applies upload timeout, and removes JSON Content-Type so the platform
 * can attach the multipart boundary.
 */
export interface UploadParams {
  formData: FormData;
  pathParam?: PathRecord;
  queryParam?: string | URLSearchParams | QueryRecord;
  timeout?: number;
}

/** Uploads need more headroom than the normal JSON request timeout. */
const UPLOAD_TIMEOUT_MS = 60_000;

declare module 'axios' {
  interface AxiosRequestConfig {
    skipAuth?: boolean;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function isApiErrorBody(value: unknown): value is ApiErrorBody {
  return isObject(value);
}

function extractPayload(body: unknown): ApiErrorBody | undefined {
  if (!isApiErrorBody(body)) return undefined;

  if (isApiErrorBody(body.error)) {
    return body.error;
  }

  return body;
}

function extractFieldErrors(body: unknown): Record<string, string> | undefined {
  if (!isApiErrorBody(body)) return undefined;

  const payload = extractPayload(body);

  const issues = payload?.issues ?? body.issues;
  if (Array.isArray(issues) && issues.length > 0) {
    return Object.fromEntries(
      issues.map((issue) => [issue.path.join('.'), issue.message]),
    );
  }

  return payload?.details?.fieldErrors ?? body.details?.fieldErrors;
}

export function normalizeError(error: unknown): NormalizedError {
  if (!isAxiosError(error)) {
    return {
      status: 0,
      code: 'client_error',
      message: error instanceof Error ? error.message : 'Something went wrong.',
      isOffline: false,
    };
  }

  const err = error as AxiosError<ApiErrorBody>;

  if (!err.response) {
    const isTimeout = err.code === 'ECONNABORTED';

    return {
      status: 0,
      code: isTimeout ? 'timeout' : 'network_error',
      message: isTimeout ? 'Request timed out.' : 'No internet connection.',
      isOffline: true,
    };
  }

  const body = err.response.data;
  const payload = extractPayload(body);
  const fieldErrors = extractFieldErrors(body);

  return {
    status: err.response.status,
    code: payload?.errorCode ?? payload?.code ?? `http_${err.response.status}`,
    message: payload?.message ?? err.message ?? 'Request failed.',
    isOffline: false,
    data: body,
    ...(fieldErrors ? { fieldErrors } : {}),
  };
}

function unwrapEnvelope<T>(responseData: unknown): T {
  if (
    isObject(responseData) &&
    'success' in responseData &&
    'data' in responseData
  ) {
    return (responseData as { data: T }).data;
  }

  return responseData as T;
}

function buildQueryString(
  queryParam?: RequestParams<unknown>['queryParam'],
): string {
  if (!queryParam) return '';

  if (typeof queryParam === 'string') {
    if (!queryParam) return '';
    return queryParam.startsWith('?') ? queryParam : `?${queryParam}`;
  }

  if (queryParam instanceof URLSearchParams) {
    const query = queryParam.toString();
    return query ? `?${query}` : '';
  }

  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(queryParam)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item === undefined || item === null) continue;
        params.append(key, String(item));
      }

      continue;
    }

    if (value === undefined || value === null) continue;
    params.set(key, String(value));
  }

  const query = params.toString();
  return query ? `?${query}` : '';
}

function queryParamForKey(
  queryParam?: RequestParams<unknown>['queryParam'],
): string | null {
  if (!queryParam) return null;

  if (typeof queryParam === 'string') {
    return queryParam.startsWith('?') ? queryParam.slice(1) : queryParam;
  }

  if (queryParam instanceof URLSearchParams) {
    return queryParam.toString();
  }

  return buildQueryString(queryParam).replace(/^\?/, '');
}

function removeHeader(headers: unknown, name: string): void {
  if (!headers || typeof headers !== 'object') return;

  const headerBag = headers as HeaderBag;

  if (typeof headerBag.delete === 'function') {
    headerBag.delete(name);
    return;
  }

  delete headerBag[name];
  delete headerBag[name.toLowerCase()];
}

function cloneHeadersWithoutAuth(
  headers?: AxiosRequestConfig['headers'],
): RawAxiosRequestHeaders {
  const cloned: RawAxiosRequestHeaders = {
    ...(headers as RawAxiosRequestHeaders | undefined),
  };

  delete cloned.Authorization;
  delete cloned.authorization;

  return cloned;
}

export class APIData {
  path: string;
  method: APIMethod;
  public?: boolean;

  public constructor(
    path: string,
    method: APIMethod,
    extraProps?: { public?: boolean },
  ) {
    this.path = path;
    this.method = method;
    this.public = extraProps?.public;
  }

  private generatePath(
    data?: PathRecord,
    queryParam?: RequestParams<unknown>['queryParam'],
  ): string {
    let result = this.path;

    if (data) {
      for (const [key, value] of Object.entries(data)) {
        if (value === undefined || value === null) continue;

        const placeholder = `:${key}`;

        if (!result.includes(placeholder)) {
          throw new Error(
            `APIData: path "${this.path}" has no ":${key}" placeholder`,
          );
        }

        result = result.replaceAll(
          placeholder,
          encodeURIComponent(String(value)),
        );
      }
    }

    const unresolved = result.match(/:[A-Za-z_][A-Za-z0-9_]*/g);

    if (unresolved) {
      throw new Error(
        `APIData: unresolved placeholders in "${this.path}": ${unresolved.join(
          ', ',
        )}`,
      );
    }

    return `${result}${buildQueryString(queryParam)}`;
  }

  private buildConfig(config?: AxiosRequestConfig): AxiosRequestConfig {
    if (!this.public) return config ?? {};

    return {
      ...config,
      skipAuth: true,
      headers: cloneHeadersWithoutAuth(config?.headers),
    };
  }

  private async routeMethod<TBody, TResponse = unknown>(
    param?: RequestParams<TBody>,
    formData?: FormData,
    config?: AxiosRequestConfig,
  ): Promise<AxiosResponse<TResponse>> {
    const updatedPath = this.generatePath(param?.pathParam, param?.queryParam);
    const updatedConfig = this.buildConfig(config);
    const body = formData ?? param?.bodyParam;

    switch (this.method) {
      case APIMethod.POST:
        return API.post<TResponse>(updatedPath, body, updatedConfig);

      case APIMethod.GET:
        return API.get<TResponse>(updatedPath, updatedConfig);

      case APIMethod.PUT:
        return API.put<TResponse>(updatedPath, body, updatedConfig);

      case APIMethod.PATCH:
        return API.patch<TResponse>(updatedPath, body, updatedConfig);

      case APIMethod.DELETE:
        return API.delete<TResponse>(updatedPath, {
          ...updatedConfig,
          data: param?.bodyParam,
        });

      default:
        throw new Error(`APIData: unsupported method "${this.method}"`);
    }
  }

  public queryOptions<TResponse>(
    params?: RequestParams<unknown>,
  ): Pick<UseQueryOptions<TResponse, NormalizedError>, 'queryKey' | 'queryFn'> {
    const queryKey: QueryKey = [
      this.path,
      params?.pathParam ?? null,
      queryParamForKey(params?.queryParam),
    ];

    return {
      queryKey,
      queryFn: async ({ signal }) => {
        try {
          const response = await this.routeMethod<unknown, TResponse>(
            params,
            undefined,
            { signal },
          );

          return unwrapEnvelope<TResponse>(response.data);
        } catch (error) {
          throw normalizeError(error);
        }
      },
    };
  }

  public mutationOptions<TResponse, TBody = unknown, TContext = unknown>(
    config?: Partial<
      Omit<
        UseMutationOptions<
          TResponse,
          NormalizedError,
          RequestParams<TBody>,
          TContext
        >,
        'mutationFn'
      >
    > & {
      onRawSuccess?: (
        response: AxiosResponse<TResponse>,
        vars: RequestParams<TBody>,
      ) => Promise<void> | void;
    },
  ): UseMutationOptions<
    TResponse,
    NormalizedError,
    RequestParams<TBody>,
    TContext
  > {
    const onRawSuccess = config?.onRawSuccess;

    const { onRawSuccess: _ignoredOnRawSuccess, ...tanstackConfig } = (config ??
      {}) as {
      onRawSuccess?: unknown;
    } & Partial<
      Omit<
        UseMutationOptions<
          TResponse,
          NormalizedError,
          RequestParams<TBody>,
          TContext
        >,
        'mutationFn'
      >
    >;

    return {
      ...tanstackConfig,
      mutationFn: async (params: RequestParams<TBody>) => {
        try {
          const response = await this.routeMethod<TBody, TResponse>(params);
          const data = unwrapEnvelope<TResponse>(response.data);

          if (onRawSuccess) {
            await onRawSuccess(
              { ...response, data } as AxiosResponse<TResponse>,
              params,
            );
          }

          return data;
        } catch (error) {
          throw normalizeError(error);
        }
      },
    };
  }

  /**
   * Multipart-upload sibling of `mutationOptions`.
   *
   * The JSON Content-Type set by the axios instance is stripped so React Native
   * and browsers can set `multipart/form-data` with the correct boundary.
   */
  public uploadMutationOptions<TResponse, TContext = unknown>(
    config?: Partial<
      Omit<
        UseMutationOptions<TResponse, NormalizedError, UploadParams, TContext>,
        'mutationFn'
      >
    > & {
      onRawSuccess?: (
        response: AxiosResponse<TResponse>,
        vars: UploadParams,
      ) => Promise<void> | void;
    },
  ): UseMutationOptions<TResponse, NormalizedError, UploadParams, TContext> {
    const onRawSuccess = config?.onRawSuccess;

    const { onRawSuccess: _ignoredOnRawSuccess, ...tanstackConfig } = (config ??
      {}) as {
      onRawSuccess?: unknown;
    } & Partial<
      Omit<
        UseMutationOptions<TResponse, NormalizedError, UploadParams, TContext>,
        'mutationFn'
      >
    >;

    return {
      ...tanstackConfig,
      mutationFn: async (params: UploadParams) => {
        try {
          const response = await this.routeMethod<unknown, TResponse>(
            {
              pathParam: params.pathParam,
              queryParam: params.queryParam,
            },
            params.formData,
            {
              timeout: params.timeout ?? UPLOAD_TIMEOUT_MS,
              transformRequest: (data, headers) => {
                removeHeader(headers, 'Content-Type');
                removeHeader(headers, 'content-type');
                return data;
              },
            },
          );

          const data = unwrapEnvelope<TResponse>(response.data);

          if (onRawSuccess) {
            await onRawSuccess(
              { ...response, data } as AxiosResponse<TResponse>,
              params,
            );
          }

          return data;
        } catch (error) {
          throw normalizeError(error);
        }
      },
    };
  }
}
