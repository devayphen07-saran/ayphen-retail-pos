import {
  AxiosError,
  AxiosRequestConfig,
  AxiosResponse,
  isAxiosError,
} from 'axios';
import type { RawAxiosRequestHeaders } from 'axios';
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

export interface NormalizedError {
  status: number;
  code: string;
  message: string;
  isOffline: boolean;
  data?: unknown;
  /** Per-field validation messages, keyed by field path (e.g. "name", "keepStoreIds"). */
  fieldErrors?: Record<string, string>;
}

export interface RequestParams<T> {
  bodyParam?: T;
  queryParam?: string | URLSearchParams | QueryRecord;
  pathParam?: PathRecord;
}

declare module 'axios' {
  interface AxiosRequestConfig {
    skipAuth?: boolean;
  }
}

function normalizeError(error: unknown): NormalizedError {
  if (!isAxiosError(error)) {
    return {
      status: 0,
      code: 'client_error',
      message: error instanceof Error ? error.message : 'Something went wrong.',
      isOffline: false,
    };
  }

  type ZodIssueLike = { path: (string | number)[]; message: string };
  const err = error as AxiosError<{
    error?: {
      errorCode?: string;
      code?: string;
      message?: string;
    };
    errorCode?: string;
    code?: string;
    message?: string;
    issues?: ZodIssueLike[];
    details?: { fieldErrors?: Record<string, string> };
  }>;

  if (!err.response) {
    return {
      status: 0,
      code: err.code === 'ECONNABORTED' ? 'timeout' : 'network_error',
      message:
        err.code === 'ECONNABORTED'
          ? 'Request timed out.'
          : 'No internet connection.',
      isOffline: true,
    };
  }

  const body = err.response.data;
  const payload =
    body?.error && typeof body.error === 'object' ? body.error : body;

  // The backend sends per-field detail two ways: Zod validation failures as a
  // flat `issues` array (path + message per field), hand-validated failures
  // (e.g. subscription reconciliation) as `details.fieldErrors`. Project both
  // into one shape so callers (handleFormError) only need to check one field.
  const fieldErrors: Record<string, string> | undefined = body?.issues?.length
    ? Object.fromEntries(body.issues.map((issue) => [issue.path.join('.'), issue.message]))
    : body?.details?.fieldErrors;

  return {
    status: err.response.status,
    code: payload?.errorCode ?? payload?.code ?? `http_${err.response.status}`,
    message: payload?.message ?? err.message ?? 'Request failed.',
    isOffline: false,
    data: body,
    ...(fieldErrors && { fieldErrors }),
  };
}

function unwrapEnvelope<T>(responseData: unknown): T {
  if (
    responseData &&
    typeof responseData === 'object' &&
    'success' in responseData &&
    'data' in responseData
  ) {
    return (responseData as { data: T }).data;
  }

  return responseData as T;
}

function buildQueryString(queryParam?: RequestParams<unknown>['queryParam']) {
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

    const headers: RawAxiosRequestHeaders = {
      ...(config?.headers as RawAxiosRequestHeaders | undefined),
    };

    delete headers['Authorization'];
    delete headers['authorization'];

    return {
      ...config,
      skipAuth: true,
      headers,
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
    }
  }

  public queryOptions<TResponse>(
    params?: RequestParams<unknown>,
  ): Pick<UseQueryOptions<TResponse, NormalizedError>, 'queryKey' | 'queryFn'> {
    const queryKey: QueryKey = [
      this.path,
      params?.pathParam ?? null,
      params?.queryParam ?? null,
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

    const { onRawSuccess: _onRawSuccess, ...tanstackConfig } = (config ??
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
      ...tanstackConfig,
    };
  }
}
