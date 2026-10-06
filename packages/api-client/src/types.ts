/**
 * Shared response/transport types for the RenderFlow HTTP API.
 *
 * These mirror the API's error envelope, which is `{ code, message, details }`
 * (PROJECT.md section 10). apps/web and any future apps/mobile both import them,
 * so a change here is a change to every client at once.
 */

/** Error codes the API can return. Mirrors `ERROR_CODES` in libs/common. */
export type KnownApiErrorCode =
  | 'VALIDATION_FAILED'
  | 'UNAUTHORIZED'
  | 'INVALID_CREDENTIALS'
  | 'CSRF_TOKEN_INVALID'
  | 'FORBIDDEN'
  | 'WORKSPACE_ACCESS_DENIED'
  | 'INSUFFICIENT_ROLE'
  | 'SSRF_BLOCKED'
  | 'NOT_FOUND'
  | 'JOB_NOT_FOUND'
  | 'CONFLICT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'EMAIL_ALREADY_REGISTERED'
  | 'JOB_ALREADY_TERMINAL'
  | 'DUPLICATE_POST'
  | 'ACCOUNT_NOT_CONNECTED'
  | 'ACCOUNT_NEEDS_REAUTH'
  | 'INSUFFICIENT_CREDITS'
  | 'MODERATION_REJECTED'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'ASSET_TOO_LARGE'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_TRANSIENT_ERROR'
  | 'PROVIDER_PERMANENT_ERROR'
  | 'PROVIDER_INVALID_OUTPUT'
  | 'PROVIDER_UNAVAILABLE'
  | 'SERVICE_UNAVAILABLE'
  | 'ACCOUNT_TOKEN_EXPIRED'
  | 'PUBLISH_REJECTED'
  | 'LEDGER_DRIFT';

/**
 * Known codes keep editor autocomplete, while `(string & {})` still admits a code
 * introduced by a newer server that this (possibly older) client has never seen.
 * A plain `| string` would collapse the union to `string` and lose completion.
 */
export type ApiErrorCode = KnownApiErrorCode | (string & {});

export interface ApiErrorBody {
  code: ApiErrorCode;
  message: string;
  details?: unknown;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** GET /health/live - process is up; no dependency checks. */
export interface LivenessResponse {
  status: 'ok';
  service: string;
  uptimeSeconds: number;
}

/** GET /health/ready - dependencies (db, redis, s3) are reachable. */
export interface ReadinessResponse {
  status: 'ok' | 'degraded';
  checks: {
    database: 'up' | 'down';
    redis: 'up' | 'down';
    storage: 'up' | 'down';
  };
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  /** Sent as the `Idempotency-Key` header. Required for any retried write. */
  idempotencyKey?: string;
  signal?: AbortSignal;
  headers?: Record<string, string>;
  /** Overrides the client default (e.g. a long job submit). */
  timeoutMs?: number;
}
