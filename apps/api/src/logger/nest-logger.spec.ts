import { createLogger } from '@renderflow/observability';
import type { Logger } from '@renderflow/observability';

import { createNestLoggerAdapter } from './nest-logger';

/**
 * Nest emits framework messages through its own `LoggerService`. Routing them
 * into pino is what keeps one structured stream (and one set of redaction rules)
 * for the whole process; a Nest log that bypasses pino could print a secret.
 */
describe('createNestLoggerAdapter', () => {
  let logger: Logger;
  let lines: string[];

  beforeEach(() => {
    lines = [];
    logger = createLogger({
      service: 'api',
      level: 'debug',
      destination: { write: (line: string) => lines.push(line) },
    });
  });

  /**
   * Nest's `LoggerService` marks its methods optional, so the returned adapter is
   * re-typed to the concrete shape. Each method is defined, which the tests then
   * call directly.
   */
  function adapter(): {
    log: (message: unknown, context?: string) => void;
    warn: (message: unknown, context?: string) => void;
    debug: (message: unknown, context?: string) => void;
    verbose: (message: unknown, context?: string) => void;
    error: (message: unknown, stack?: string, context?: string) => void;
    fatal: (message: unknown, context?: string) => void;
  } {
    return createNestLoggerAdapter(logger) as ReturnType<typeof createNestLoggerAdapter> & {
      log: (message: unknown, context?: string) => void;
      warn: (message: unknown, context?: string) => void;
      debug: (message: unknown, context?: string) => void;
      verbose: (message: unknown, context?: string) => void;
      error: (message: unknown, stack?: string, context?: string) => void;
      fatal: (message: unknown, context?: string) => void;
    };
  }

  function parsed(index: number): Record<string, unknown> {
    const parsedLine: unknown = JSON.parse(lines[index] ?? '{}');
    return parsedLine as Record<string, unknown>;
  }

  it('maps log() to pino info with the Nest context', () => {
    adapter().log('Nest application successfully started', 'InstanceLoader');

    expect(parsed(0)).toMatchObject({
      level: 'info',
      msg: 'Nest application successfully started',
      nest: 'InstanceLoader',
    });
  });

  it('maps warn() to pino warn', () => {
    adapter().warn('slow drain', 'GracefulShutdown');
    expect(parsed(0)).toMatchObject({ level: 'warn', msg: 'slow drain' });
  });

  it('maps debug() to pino debug', () => {
    adapter().debug('resolved route', 'RoutesResolver');
    expect(parsed(0)).toMatchObject({ level: 'debug', msg: 'resolved route' });
  });

  it('maps verbose() to debug with a marker', () => {
    adapter().verbose('chatty detail', 'SomeModule');
    expect(parsed(0)).toMatchObject({
      level: 'debug',
      msg: 'chatty detail',
      verbose: true,
    });
  });

  it('maps error() to pino error and keeps the stack', () => {
    adapter().error('boom', 'Error: boom\n    at x.ts:1', 'SomeModule');

    expect(parsed(0)).toMatchObject({ level: 'error', msg: 'boom', nest: 'SomeModule' });
    expect(lines[0]).toContain('at x.ts:1');
  });

  it('maps fatal() to an error with a marker', () => {
    adapter().fatal('cannot boot', 'Bootstrap');
    expect(parsed(0)).toMatchObject({ level: 'error', fatal: true, msg: 'cannot boot' });
  });

  it('tolerates a missing context', () => {
    adapter().log('no context supplied');
    expect(parsed(0)).toMatchObject({ level: 'info', msg: 'no context supplied' });
  });

  it('coerces a non-string message', () => {
    adapter().log({ some: 'object' });
    expect(parsed(0)).toMatchObject({ level: 'info' });
    expect(lines[0]).toContain('object');
  });

  it('redacts through the shared logger, not around it', () => {
    // A Nest log carrying a token must be scrubbed like any other.
    logger.info({ accessToken: 'should-not-appear' }, 'token in log');
    expect(lines.join('')).not.toContain('should-not-appear');
  });
});
