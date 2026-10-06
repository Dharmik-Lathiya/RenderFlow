import { HttpException, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';

import { AppError, ERROR_CODES } from '@renderflow/common';

import { AllExceptionsFilter, configureExceptionLogger } from './all-exceptions.filter';
import { createLogger } from '@renderflow/observability';

/**
 * The filter is the boundary between internal failures and what a client sees, so
 * the important tests are the negative ones: an unexpected error must NOT leak its
 * message or stack.
 */
describe('AllExceptionsFilter', () => {
  let filter: AllExceptionsFilter;
  let json: jest.Mock;
  let status: jest.Mock;
  let sink: { write: (line: string) => void } | null;

  const host = {
    switchToHttp: () => ({
      getResponse: () => ({ status, json }) as never,
      getRequest: () => ({ method: 'GET', url: '/api/v1/credits' }) as never,
    }),
  };

  beforeEach(async () => {
    json = jest.fn();
    status = jest.fn().mockReturnThis();

    // Route the filter's structured logs into a capture sink so the suite stays
    // quiet, and so a test could assert on what was (not) logged.
    const lines: string[] = [];
    sink = { write: (line: string): void => void lines.push(line) };
    configureExceptionLogger(createLogger({ service: 'api', level: 'debug', destination: sink }));

    const moduleRef = await Test.createTestingModule({
      providers: [AllExceptionsFilter],
    }).compile();
    filter = moduleRef.get(AllExceptionsFilter);
  });

  afterEach(() => {
    sink = null;
  });

  function expectRun(exception: unknown): void {
    filter.catch(exception, host as never);
  }

  it('returns an AppError body verbatim with its own status', () => {
    const error = new AppError(ERROR_CODES.INSUFFICIENT_CREDITS, undefined, {
      details: { required: 30, available: 12 },
    });

    expectRun(error);

    expect(status).toHaveBeenCalledWith(402);
    expect(json).toHaveBeenCalledWith({
      code: 'INSUFFICIENT_CREDITS',
      message: 'Not enough credits for this action.',
      details: { required: 30, available: 12 },
    });
  });

  it('never leaks an unexpected error message or stack', () => {
    const error = new Error('connection to postgres://user:pw@host failed');

    expectRun(error);

    expect(status).toHaveBeenCalledWith(500);
    const body = json.mock.calls[0]?.[0] as { code: string; message: string; details?: unknown };
    expect(body.code).toBe('INTERNAL_ERROR');
    expect(body.message).toBe('An unexpected error occurred.');
    expect(JSON.stringify(body)).not.toContain('postgres://');
    expect(body.details).toBeUndefined();
  });

  it('logs the full error even though the response hides it', () => {
    // The point of the split: operators keep the diagnostic, users do not.
    const lines: string[] = [];
    configureExceptionLogger(
      createLogger({
        service: 'api',
        level: 'debug',
        destination: { write: (line: string) => lines.push(line) },
      }),
    );

    expectRun(new Error('upstream refused the connection'));

    const logged = lines.join('');
    expect(logged).toContain('upstream refused the connection');
    expect(logged).toContain('unhandled exception');
  });

  it('hides a stack trace', () => {
    const error = new Error('boom at /srv/app/dist/main.js:42');
    expectRun(error);
    expect(JSON.stringify(json.mock.calls[0]?.[0])).not.toContain('dist/main.js');
  });

  it('maps a Nest 404 onto NOT_FOUND', () => {
    expectRun(new HttpException('Cannot GET /nope', HttpStatus.NOT_FOUND));
    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'NOT_FOUND', message: 'Cannot GET /nope' }),
    );
  });

  it('joins the array messages Nest produces for validation failures', () => {
    const exception = new HttpException(
      { message: ['name must be a string', 'email must be a string'], statusCode: 400 },
      HttpStatus.BAD_REQUEST,
    );

    expectRun(exception);

    const body = json.mock.calls[0]?.[0] as { code: string; message: string };
    expect(body.code).toBe('VALIDATION_FAILED');
    expect(body.message).toBe('name must be a string, email must be a string');
  });

  it('maps common statuses onto the documented vocabulary', () => {
    const cases: Array<[number, string]> = [
      [401, 'UNAUTHORIZED'],
      [403, 'FORBIDDEN'],
      [409, 'CONFLICT'],
      [413, 'ASSET_TOO_LARGE'],
      [415, 'UNSUPPORTED_MEDIA_TYPE'],
      [429, 'RATE_LIMITED'],
      [503, 'SERVICE_UNAVAILABLE'],
    ];

    for (const [statusCode, expected] of cases) {
      json = jest.fn();
      status = jest.fn().mockReturnThis();

      filter.catch(new HttpException('x', statusCode), host as never);

      expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: expected }));
    }
  });

  it('always produces the documented { code, message } shape', () => {
    for (const exception of [
      new AppError(ERROR_CODES.NOT_FOUND),
      new Error('unknown'),
      new HttpException('nope', HttpStatus.NOT_FOUND),
    ]) {
      json = jest.fn();
      status = jest.fn().mockReturnThis();

      filter.catch(exception, host as never);

      const body = json.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(body).toHaveProperty('code');
      expect(body).toHaveProperty('message');
      expect(typeof body.code).toBe('string');
      expect(typeof body.message).toBe('string');
    }
  });
});

describe('ConfigService shape used by guards', () => {
  it('is injectable, which the guards rely on', async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [ConfigModuleStub],
    }).compile();

    const config = moduleRef.get(ConfigService);
    expect(config.get('JWT_ACCESS_SECRET')).toBe('x'.repeat(32));
  });
});

/** Minimal provider standing in for the global ConfigModule. */
const ConfigModuleStub = {
  provide: ConfigService,
  useValue: new ConfigService({ JWT_ACCESS_SECRET: 'x'.repeat(32) }),
};
