import { ERROR_CODES, type ErrorCode } from './error-codes';

/** Wire format returned to clients: `{ code, message, details }`. PROJECT.md section 10. */
export interface AppErrorBody {
  code: ErrorCode;
  message: string;
  details?: unknown;
}

export interface AppErrorOptions {
  /** Structured, client-safe context. Never put secrets or tokens here. */
  details?: unknown;
  cause?: unknown;
}

/**
 * Default HTTP status per error code. Keeping the mapping in one table stops
 * the same code from surfacing as 500 on one route and 409 on another.
 */
const HTTP_STATUS_BY_CODE: Readonly<Record<ErrorCode, number>> = {
  VALIDATION_FAILED: 400,
  UNAUTHORIZED: 401,
  INVALID_CREDENTIALS: 401,
  CSRF_TOKEN_INVALID: 403,
  FORBIDDEN: 403,
  WORKSPACE_ACCESS_DENIED: 403,
  INSUFFICIENT_ROLE: 403,
  SSRF_BLOCKED: 403,
  NOT_FOUND: 404,
  JOB_NOT_FOUND: 404,
  CONFLICT: 409,
  IDEMPOTENCY_CONFLICT: 409,
  EMAIL_ALREADY_REGISTERED: 409,
  JOB_ALREADY_TERMINAL: 409,
  DUPLICATE_POST: 409,
  ACCOUNT_NOT_CONNECTED: 409,
  ACCOUNT_NEEDS_REAUTH: 409,
  INSUFFICIENT_CREDITS: 402,
  MODERATION_REJECTED: 422,
  UNSUPPORTED_MEDIA_TYPE: 415,
  ASSET_TOO_LARGE: 413,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
  PROVIDER_PERMANENT_ERROR: 502,
  PROVIDER_INVALID_OUTPUT: 502,
  ACCOUNT_TOKEN_EXPIRED: 502,
  PUBLISH_REJECTED: 502,
  PROVIDER_TRANSIENT_ERROR: 503,
  PROVIDER_TIMEOUT: 504,
  SERVICE_UNAVAILABLE: 503,
  PROVIDER_UNAVAILABLE: 503,
  LEDGER_DRIFT: 500,
};

export function httpStatusForCode(code: ErrorCode): number {
  return HTTP_STATUS_BY_CODE[code] ?? 500;
}

const DEFAULT_MESSAGES: Readonly<Partial<Record<ErrorCode, string>>> = {
  VALIDATION_FAILED: 'The request payload failed validation.',
  UNAUTHORIZED: 'Authentication is required.',
  FORBIDDEN: 'You do not have access to this resource.',
  NOT_FOUND: 'The requested resource was not found.',
  CONFLICT: 'The request conflicts with the current state.',
  RATE_LIMITED: 'Too many requests. Please retry later.',
  INTERNAL_ERROR: 'An unexpected error occurred.',
  INSUFFICIENT_CREDITS: 'Not enough credits for this action.',
  MODERATION_REJECTED: 'The request was rejected by content moderation.',
  IDEMPOTENCY_CONFLICT: 'An idempotency key was reused with a different payload.',
  EMAIL_ALREADY_REGISTERED: 'An account with that email already exists.',
  JOB_NOT_FOUND: 'The generation job was not found.',
  ACCOUNT_TOKEN_EXPIRED: 'The linked social account token has expired.',
  LEDGER_DRIFT: 'The credit ledger does not reconcile with wallet balances.',
};

export function defaultMessageForCode(code: ErrorCode): string {
  return DEFAULT_MESSAGES[code] ?? 'The request could not be completed.';
}

/**
 * Base class for every expected (i.e. non-bug) failure.
 *
 * Anything thrown that is *not* an `AppError` is treated as an unexpected
 * error by the global exception filter: logged with a stack trace and reported
 * to the client as a generic 500, so internal details never leak.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details: unknown;

  constructor(code: ErrorCode, message?: string, options: AppErrorOptions = {}) {
    super(
      message ?? defaultMessageForCode(code),
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.code = code;
    this.details = options.details;
    this.name = new.target.name;
  }

  get httpStatus(): number {
    return httpStatusForCode(this.code);
  }

  toBody(): AppErrorBody {
    const body: AppErrorBody = { code: this.code, message: this.message };
    if (this.details !== undefined) {
      body.details = this.details;
    }
    return body;
  }

  toJSON(): AppErrorBody {
    return this.toBody();
  }

  static is(value: unknown): value is AppError {
    return value instanceof AppError;
  }
}

/** Raised when a guarded reserve finds `available < cost`. Nothing is created. */
export class InsufficientCreditsError extends AppError {
  constructor(required: number, available: number) {
    super(ERROR_CODES.INSUFFICIENT_CREDITS, undefined, { details: { required, available } });
  }
}

export class ModerationRejectedError extends AppError {
  constructor(reason: string) {
    super(ERROR_CODES.MODERATION_REJECTED, undefined, { details: { reason } });
  }
}

/** Raised when an idempotency key is replayed with a different request payload. */
export class IdempotencyConflictError extends AppError {
  constructor(key: string) {
    super(ERROR_CODES.IDEMPOTENCY_CONFLICT, undefined, { details: { idempotencyKey: key } });
  }
}

export class ValidationFailedError extends AppError {
  constructor(details: unknown) {
    super(ERROR_CODES.VALIDATION_FAILED, undefined, { details });
  }
}

export class ResourceNotFoundError extends AppError {
  constructor(resource: string, id: string) {
    super(ERROR_CODES.NOT_FOUND, undefined, { details: { resource, id } });
  }
}

/**
 * Multi-tenant isolation failure: caller is authenticated but not a member.
 *
 * `resource` is carried when the caller named a resource type but deliberately
 * did NOT name the id. "You may not touch that post" and "no such post exists"
 * have to be indistinguishable, so a resource-scoped rejection cannot say which
 * workspace it was aiming at.
 */
export class WorkspaceAccessDeniedError extends AppError {
  constructor(workspaceId: string, resource?: string) {
    super(ERROR_CODES.WORKSPACE_ACCESS_DENIED, undefined, {
      details: resource === undefined ? { workspaceId } : { resource },
    });
  }
}

export function toAppError(error: unknown): AppError {
  return AppError.is(error)
    ? error
    : new AppError(ERROR_CODES.INTERNAL_ERROR, undefined, { cause: error });
}
