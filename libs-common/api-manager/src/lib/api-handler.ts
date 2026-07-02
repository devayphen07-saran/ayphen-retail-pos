import { createAsyncThunk } from '@reduxjs/toolkit';
import { AxiosError, AxiosRequestConfig, AxiosResponse, isAxiosError } from 'axios';
import type {
  UseQueryOptions,
  UseMutationOptions,
  QueryKey,
} from '@tanstack/react-query';
import { API } from './axios-instances';

export enum APIMethod {
  POST = 'post',
  GET = 'get',
  PUT = 'put',
  DELETE = 'delete',
  PATCH = 'patch',
}

type PathRecord = Record<string, string | number | undefined>;

export interface NormalizedError {
  status: number;
  code: string;
  message: string;
  isOffline: boolean;
  data?: unknown;
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

  const err = error as AxiosError<{
    error?: { errorCode?: string; code?: string; message?: string };
    errorCode?: string;
    code?: string;
    message?: string;
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
  // Server error shape: { error: { code, message, ... } }
  // Fall back to root-level fields for non-standard responses.
  const payload =
    body?.error && typeof body.error === 'object' ? body.error : body;

  return {
    status: err.response.status,
    code: payload?.errorCode ?? payload?.code ?? `http_${err.response.status}`,
    message: payload?.message ?? err.message ?? 'Request failed.',
    isOffline: false,
    data: body,
  };
}

export class APIData {
  path: string;
  method: APIMethod;
  // API that doesn't need auth token (login, register)
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

  private generatePath(data?: PathRecord, queryParam?: string): string {
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
        `APIData: unresolved placeholders in "${this.path}": ${unresolved.join(', ')}`,
      );
    }

    return queryParam ? `${result}${queryParam}` : result;
  }

  private async routeMethod<T>(
    param?: RequestParams<T>,
    formData?: FormData,
    config?: AxiosRequestConfig,
  ): Promise<AxiosResponse> {
    const updatedPath = this.generatePath(param?.pathParam, param?.queryParam);

    let updatedConfig = config;
    if (this.public) {
      updatedConfig = { ...config, headers: { ...config?.headers } };
      delete updatedConfig.headers!.Authorization;
      delete updatedConfig.headers!.authorization;
    }

    const body = formData ?? param?.bodyParam;

    switch (this.method) {
      case APIMethod.POST:
        return API.post(updatedPath, body, updatedConfig);
      case APIMethod.GET:
        return API.get(updatedPath, updatedConfig);
      case APIMethod.PUT:
        return API.put(updatedPath, body, updatedConfig);
      case APIMethod.PATCH:
        return API.patch(updatedPath, body, updatedConfig);
      case APIMethod.DELETE:
        return API.delete(updatedPath, {
          ...updatedConfig,
          data: param?.bodyParam,
        });
    }
  }

  public generateAsyncThunk<Returned, ThunkArg>(typePrefix: string) {
    return createAsyncThunk<
      Returned,
      RequestParams<ThunkArg> | undefined,
      { rejectValue: NormalizedError }
    >(typePrefix, async (param, { rejectWithValue }) => {
      try {
        const response = await this.routeMethod<ThunkArg>(param);
        return response.data as Returned;
      } catch (error) {
        return rejectWithValue(normalizeError(error));
      }
    });
  }

  public generateAsyncThunkForMultipart<Returned, ThunkArg>(
    typePrefix: string,
  ) {
    return createAsyncThunk<
      Returned,
      RequestParamsMultiPart<ThunkArg>,
      { rejectValue: NormalizedError }
    >(typePrefix, async (props, { rejectWithValue }) => {
      try {
        const formData = new FormData();
        if (props.file) {
          formData.append('file', props.file);
        }
        const config = {
          headers: { 'content-type': 'multipart/form-data' },
        };
        const response = await this.routeMethod<ThunkArg>(
          { pathParam: props.pathParam, queryParam: props.queryParam },
          formData,
          config,
        );
        return response.data as Returned;
      } catch (error) {
        return rejectWithValue(normalizeError(error));
      }
    });
  }

  // ============================================
  // TanStack Query Support
  // ============================================

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
      // Forward TanStack Query's AbortSignal to axios so navigating away from
      // a screen (or a superseded query) cancels the in-flight request
      // instead of letting it run to completion (NETWORK_LAYER §9).
      queryFn: async ({ signal }) => {
        try {
          const response = await this.routeMethod(params, undefined, { signal });
          return response.data as TResponse;
        } catch (error) {
          throw normalizeError(error);
        }
      },
    };
  }

  public mutationOptions<TResponse, TBody = unknown, TContext = unknown>(
    config?: Partial<
      Omit<UseMutationOptions<TResponse, NormalizedError, RequestParams<TBody>, TContext>, 'mutationFn'>
    > & {
      // Called with the raw Axios response before TanStack's onSuccess fires.
      // Needed for mutations that must read response headers (e.g. permission
      // snapshot piggyback on invitation accept).
      onRawSuccess?: (
        response: AxiosResponse<TResponse>,
        vars: RequestParams<TBody>,
      ) => Promise<void> | void;
    },
  ): UseMutationOptions<TResponse, NormalizedError, RequestParams<TBody>, TContext> {
    const onRawSuccess = config?.onRawSuccess;
    const { onRawSuccess: _rs, ...tanstackConfig } = (config ?? {}) as {
      onRawSuccess?: unknown;
    } & Partial<Omit<UseMutationOptions<TResponse, NormalizedError, RequestParams<TBody>, TContext>, 'mutationFn'>>;

    return {
      mutationFn: async (params: RequestParams<TBody>) => {
        try {
          const response = await this.routeMethod<TBody>(params);
          if (onRawSuccess) {
            await onRawSuccess(response as AxiosResponse<TResponse>, params);
          }
          return response.data as TResponse;
        } catch (error) {
          throw normalizeError(error);
        }
      },
      ...tanstackConfig,
    };
  }
}

export interface RequestParams<T> {
  bodyParam?: T;
  queryParam?: string;
  pathParam?: PathRecord;
}

export interface RequestParamsMultiPart<T> {
  request?: T;
  file: Blob;
  queryParam?: string;
  pathParam?: PathRecord;
}
