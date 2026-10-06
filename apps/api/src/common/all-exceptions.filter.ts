import { ArgumentsHost, Catch, HttpException, type ExceptionFilter } from '@nestjs/common';
import { AppError, ERROR_CODES, type ErrorCode } from '@renderflow/common';
import { createLogger } from '@renderflow/observability';
import type { Response } from 'express';

/**
 * Resolved lazily so a unit test that constructs the filter without app config
 * cannot fail; production calls `configureExceptionLogger` from main.ts.
 */
let logger: ReturnType<typeof createLogger> | null = null;

/** Wires the filter's logger at boot. Called once from `main.ts`. */
export function configureExceptionLogger(instance: ReturnType<typeof createLogger>): void {
  logger = instance;
}

function log(): ReturnType<typeof createLogger> {
  logger ??= createLogger({ service: 'api', base: { component: 'exception-filter' } });
  return logger;
}

interface ErrorBody {
  code: ErrorCode;
  message: string;
  details?: unknown;
}

/**
 * Global exception filter producing `{ code, message, details }`
 * (AGENTS.md section 7, PROJECT.md section 10).
 *
 * Two rules drive the implementation:
 *
 *  1. An `AppError` is an *expected* failure: its message is safe to return.
 *  2. Anything else is a bug. The client gets a generic 500 and no detail, while
 *     the full error and stack go to the log. This is what stops a leaked stack
 *     trace (or a leaked SQL fragment) from reaching a user.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const request = host.switchToHttp().getRequest<{ method: string; url: string }>();

    const body = this.toBody(exception);

    if (body.code === ERROR_CODES.INTERNAL_ERROR) {
      log().error(
        {
          method: request.method,
          url: request.url,
          status: 500,
          err: exception,
        },
        'unhandled exception',
      );
    } else {
      log().warn(
        { method: request.method, url: request.url, errorCode: body.code },
        'request rejected',
      );
    }

    response.status(this.toStatus(exception, body.code)).json(body);
  }

  private toBody(exception: unknown): ErrorBody {
    if (AppError.is(exception)) {
      return exception.toBody();
    }

    // Nest's own HTTP exceptions (404 route-not-found, 405, payload too large).
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();
      return {
        code: this.codeForStatus(status),
        message: this.messageFromHttpException(payload, exception.message),
        ...(typeof payload === 'object' && payload !== null && 'message' in payload
          ? { details: payload.message }
          : {}),
      };
    }

    return {
      code: ERROR_CODES.INTERNAL_ERROR,
      message: 'An unexpected error occurred.',
    };
  }

  private toStatus(exception: unknown, fallbackCode: ErrorCode): number {
    if (exception instanceof HttpException) {
      return exception.getStatus();
    }
    return new AppError(fallbackCode).httpStatus;
  }

  /** Maps an HTTP status onto our stable error vocabulary. */
  private codeForStatus(status: number): ErrorCode {
    switch (status) {
      case 400:
        return ERROR_CODES.VALIDATION_FAILED;
      case 401:
        return ERROR_CODES.UNAUTHORIZED;
      case 402:
        return ERROR_CODES.INSUFFICIENT_CREDITS;
      case 403:
        return ERROR_CODES.FORBIDDEN;
      case 404:
        return ERROR_CODES.NOT_FOUND;
      case 409:
        return ERROR_CODES.CONFLICT;
      case 413:
        return ERROR_CODES.ASSET_TOO_LARGE;
      case 415:
        return ERROR_CODES.UNSUPPORTED_MEDIA_TYPE;
      case 422:
        return ERROR_CODES.MODERATION_REJECTED;
      case 429:
        return ERROR_CODES.RATE_LIMITED;
      case 503:
        return ERROR_CODES.SERVICE_UNAVAILABLE;
      default:
        return ERROR_CODES.INTERNAL_ERROR;
    }
  }

  private messageFromHttpException(payload: unknown, fallback: string): string {
    if (typeof payload === 'string') {
      return payload;
    }
    if (typeof payload === 'object' && payload !== null && 'message' in payload) {
      const message = payload.message;
      if (typeof message === 'string') {
        return message;
      }
      if (Array.isArray(message)) {
        return message.join(', ');
      }
    }
    return fallback;
  }
}
