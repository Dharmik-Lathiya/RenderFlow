import { ERROR_CODES } from './error-codes';
import {
  AppError,
  IdempotencyConflictError,
  InsufficientCreditsError,
  ModerationRejectedError,
  ResourceNotFoundError,
  ValidationFailedError,
  WorkspaceAccessDeniedError,
  defaultMessageForCode,
  httpStatusForCode,
  toAppError,
} from './app-error';

describe('httpStatusForCode', () => {
  it('maps the credit codes from PROJECT.md section 10', () => {
    expect(httpStatusForCode(ERROR_CODES.INSUFFICIENT_CREDITS)).toBe(402);
    expect(httpStatusForCode(ERROR_CODES.MODERATION_REJECTED)).toBe(422);
    expect(httpStatusForCode(ERROR_CODES.IDEMPOTENCY_CONFLICT)).toBe(409);
    expect(httpStatusForCode(ERROR_CODES.ACCOUNT_TOKEN_EXPIRED)).toBe(502);
  });

  it('maps the common auth and tenancy codes', () => {
    expect(httpStatusForCode(ERROR_CODES.UNAUTHORIZED)).toBe(401);
    expect(httpStatusForCode(ERROR_CODES.FORBIDDEN)).toBe(403);
    expect(httpStatusForCode(ERROR_CODES.NOT_FOUND)).toBe(404);
    expect(httpStatusForCode(ERROR_CODES.RATE_LIMITED)).toBe(429);
    expect(httpStatusForCode(ERROR_CODES.INTERNAL_ERROR)).toBe(500);
  });

  it('covers every declared code so none can drift to an unlisted default', () => {
    for (const code of Object.values(ERROR_CODES)) {
      const status = httpStatusForCode(code);
      expect(Number.isInteger(status)).toBe(true);
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(600);
    }
  });
});

describe('AppError', () => {
  it('carries a stable code and maps to an HTTP status', () => {
    const error = new AppError(ERROR_CODES.CONFLICT, 'already scheduled');
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('CONFLICT');
    expect(error.httpStatus).toBe(409);
    expect(error.message).toBe('already scheduled');
  });

  it('falls back to a default message when none is given', () => {
    expect(new AppError(ERROR_CODES.VALIDATION_FAILED).message).toBe(
      'The request payload failed validation.',
    );
    expect(defaultMessageForCode(ERROR_CODES.NOT_FOUND)).toBe(
      'The requested resource was not found.',
    );
  });

  it('serialises to the documented { code, message, details } body', () => {
    const error = new AppError(ERROR_CODES.VALIDATION_FAILED, 'bad', {
      details: { field: 'goal' },
    });
    expect(error.toBody()).toEqual({
      code: 'VALIDATION_FAILED',
      message: 'bad',
      details: { field: 'goal' },
    });
    expect(JSON.parse(JSON.stringify(error))).toEqual({
      code: 'VALIDATION_FAILED',
      message: 'bad',
      details: { field: 'goal' },
    });
  });

  it('omits details entirely when none were provided', () => {
    expect(Object.keys(new AppError(ERROR_CODES.NOT_FOUND).toBody())).toEqual(['code', 'message']);
  });

  it('keeps the original error as cause', () => {
    const original = new Error('socket hang up');
    const error = new AppError(ERROR_CODES.SERVICE_UNAVAILABLE, undefined, { cause: original });
    expect(error.cause).toBe(original);
  });

  it('identifies AppError instances', () => {
    expect(AppError.is(new AppError(ERROR_CODES.CONFLICT))).toBe(true);
    expect(AppError.is(new Error('nope'))).toBe(false);
    expect(AppError.is(null)).toBe(false);
  });
});

describe('domain errors', () => {
  it('InsufficientCreditsError reports required vs available and 402', () => {
    const error = new InsufficientCreditsError(30, 12);
    expect(error.code).toBe('INSUFFICIENT_CREDITS');
    expect(error.httpStatus).toBe(402);
    expect(error.toBody().details).toEqual({ required: 30, available: 12 });
    expect(error.name).toBe('InsufficientCreditsError');
  });

  it('ModerationRejectedError carries the reason and 422', () => {
    const error = new ModerationRejectedError('policy violation');
    expect(error.code).toBe('MODERATION_REJECTED');
    expect(error.httpStatus).toBe(422);
    expect(error.toBody().details).toEqual({ reason: 'policy violation' });
  });

  it('IdempotencyConflictError echoes the offending key and 409', () => {
    const error = new IdempotencyConflictError('abc-123');
    expect(error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(error.toBody().details).toEqual({ idempotencyKey: 'abc-123' });
  });

  it('ValidationFailedError passes details through', () => {
    const error = new ValidationFailedError({ goal: ['required'] });
    expect(error.httpStatus).toBe(400);
    expect(error.toBody().details).toEqual({ goal: ['required'] });
  });

  it('ResourceNotFoundError names the resource and id', () => {
    const error = new ResourceNotFoundError('post', 'p1');
    expect(error.httpStatus).toBe(404);
    expect(error.toBody().details).toEqual({ resource: 'post', id: 'p1' });
  });

  it('WorkspaceAccessDeniedError is a 403 tenancy failure', () => {
    const error = new WorkspaceAccessDeniedError('w1');
    expect(error.code).toBe('WORKSPACE_ACCESS_DENIED');
    expect(error.httpStatus).toBe(403);
    expect(error.toBody().details).toEqual({ workspaceId: 'w1' });
  });

  it('subclasses are recognised as AppError', () => {
    expect(new InsufficientCreditsError(1, 0)).toBeInstanceOf(AppError);
  });
});

describe('toAppError', () => {
  it('passes AppError through untouched', () => {
    const original = new ValidationFailedError('x');
    expect(toAppError(original)).toBe(original);
  });

  it('wraps anything else as an internal error without leaking the message', () => {
    const wrapped = toAppError(new TypeError('cannot read x of undefined'));
    expect(wrapped.code).toBe(ERROR_CODES.INTERNAL_ERROR);
    expect(wrapped.httpStatus).toBe(500);
    expect(wrapped.message).not.toContain('cannot read x');
  });
});
