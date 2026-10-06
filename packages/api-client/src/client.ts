import type {
  ApiErrorBody,
  ApiErrorCode,
  LivenessResponse,
  ReadinessResponse,
  RequestOptions,
} from './types';

/**
 * Typed transport for the RenderFlow REST API.
 *
 * This package is the single HTTP client for every RenderFlow front end:
 * apps/web imports it today, and a future apps/mobile imports the same module so
 * neither can drift from the API contract (PROJECT.md section 3.1).
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface RenderFlowClientOptions {
  /** Full API prefix, e.g. `http://localhost:4000/api/v1`. */
  baseUrl: string;
  /**
   * `fetch` implementation. Injectable so tests never touch the network
   * (AGENTS.md section 9: tests must not use real network).
   */
  fetchImpl?: FetchLike;
  /**
   * Bearer token source. The web app authenticates with httpOnly cookies and can
   * omit this; mobile keeps a token in secure storage and provides it here.
   */
  getToken?: () => string | null | Promise<string | null>;
  /** Send cookies with every request (browser sessions). Default true. */
  withCredentials?: boolean;
  /** Default per-request timeout in ms. Default 30000. */
  timeoutMs?: number;
  headers?: Record<string, string>;
}

export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';
export const DEFAULT_TIMEOUT_MS = 30_000;

/** Thrown for any non-2xx response. Carries the API's stable error code. */
export class ApiClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }

  /** True when retrying the same request could plausibly succeed. */
  get isRetryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }

  /** True when the user ran out of credits and the UI should show the upsell. */
  get isInsufficientCredits(): boolean {
    return this.code === 'INSUFFICIENT_CREDITS' || this.status === 402;
  }
}

export interface RenderFlowClient {
  request<T>(method: string, path: string, body?: unknown, options?: RequestOptions): Promise<T>;
  get<T>(path: string, options?: RequestOptions): Promise<T>;
  post<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T>;
  patch<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T>;
  delete<T>(path: string, options?: RequestOptions): Promise<T>;
  health: {
    live(): Promise<LivenessResponse>;
    ready(): Promise<ReadinessResponse>;
  };
}

function buildUrl(baseUrl: string, path: string, query: RequestOptions['query']): string {
  const base = baseUrl.replace(/\/+$/, '');
  const suffix = path.startsWith('/') ? path : `/${path}`;
  const url = new URL(`${base}${suffix}`);

  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

/**
 * Health and metrics sit outside the versioned prefix so orchestrator probes and
 * Prometheus do not need a version. Strip `/api/vN` to find the server root.
 */
export function apiRootFrom(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '').replace(/\/api\/v\d+$/, '');
}

async function parseBody(response: Response): Promise<unknown> {
  if (response.status === 204) {
    return undefined;
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    return response.json();
  }
  const text = await response.text();
  return text === '' ? undefined : text;
}

export function createRenderFlowClient(options: RenderFlowClientOptions): RenderFlowClient {
  const {
    baseUrl,
    fetchImpl = globalThis.fetch,
    getToken,
    withCredentials = true,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    headers: baseHeaders = {},
  } = options;

  if (typeof fetchImpl !== 'function') {
    throw new TypeError('createRenderFlowClient requires a fetch implementation');
  }

  async function request<T>(
    method: string,
    path: string,
    body?: unknown,
    requestOptions: RequestOptions = {},
  ): Promise<T> {
    return send<T>(
      buildUrl(baseUrl, path, requestOptions.query),
      method,
      body,
      requestOptions,
      path,
    );
  }

  async function send<T>(
    url: string,
    method: string,
    body?: unknown,
    requestOptions: RequestOptions = {},
    /** Only used to build error messages. */
    path = url,
  ): Promise<T> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...baseHeaders,
      ...requestOptions.headers,
    };

    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    if (requestOptions.idempotencyKey) {
      headers[IDEMPOTENCY_KEY_HEADER] = requestOptions.idempotencyKey;
    }

    const token = getToken ? await getToken() : null;
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    // Compose the caller's signal with our timeout signal.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), requestOptions.timeoutMs ?? timeoutMs);
    const externalSignal = requestOptions.signal;
    const onExternalAbort = (): void => controller.abort();

    if (externalSignal) {
      if (externalSignal.aborted) {
        controller.abort();
      } else {
        externalSignal.addEventListener('abort', onExternalAbort, { once: true });
      }
    }

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: withCredentials ? 'include' : 'omit',
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new ApiClientError(408, 'TIMEOUT', `Request to ${path} timed out or was aborted`);
      }
      throw new ApiClientError(503, 'NETWORK_ERROR', `Request to ${path} failed`, error);
    } finally {
      clearTimeout(timeout);
      externalSignal?.removeEventListener('abort', onExternalAbort);
    }

    const parsed = await parseBody(response);

    if (!response.ok) {
      const envelope = (parsed ?? {}) as ApiErrorBody;
      throw new ApiClientError(
        response.status,
        envelope.code ?? 'UNKNOWN_ERROR',
        envelope.message ?? `Request to ${path} failed with ${response.status}`,
        envelope.details,
      );
    }

    return parsed as T;
  }

  return {
    request,
    get: (path, requestOptions) => request('GET', path, undefined, requestOptions),
    post: (path, body, requestOptions) => request('POST', path, body, requestOptions),
    patch: (path, body, requestOptions) => request('PATCH', path, body, requestOptions),
    delete: (path, requestOptions) => request('DELETE', path, undefined, requestOptions),
    health: {
      // Absolute: health lives at the server root, not under /api/v1.
      live: () => send<LivenessResponse>(`${apiRootFrom(baseUrl)}/health/live`, 'GET'),
      ready: () => send<ReadinessResponse>(`${apiRootFrom(baseUrl)}/health/ready`, 'GET'),
    },
  };
}
