import {
  REDACTED_FIELD_NAMES,
  REDACTION_PLACEHOLDER,
  createLogger,
  deepRedact,
  isSensitiveKey,
  toShutdownLogger,
} from './logger';

function captureLogger(level = 'info') {
  const lines: string[] = [];
  const destination = {
    write: (line: string): void => {
      lines.push(line);
    },
  };
  return { logger: createLogger({ level, service: 'test', destination }), lines };
}

/** JSON.parse returns `any`; funnel it through `unknown` so lint stays strict. */
function parseLogLine(line: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(line);
  return parsed as Record<string, unknown>;
}

function lineAt(lines: string[], index: number): string {
  const line = lines[index];
  if (line === undefined) {
    throw new Error(`expected a log line at index ${index}, got ${lines.length} lines`);
  }
  return line;
}

describe('isSensitiveKey', () => {
  it('matches regardless of separator or case', () => {
    for (const key of ['token', 'accessToken', 'access_token', 'ACCESS-TOKEN', 'refresh token']) {
      expect(isSensitiveKey(key)).toBe(true);
    }
  });

  it('does not match innocent fields', () => {
    for (const key of ['tokenCount', 'postId', 'workspaceId', 'stage', 'jobId']) {
      expect(isSensitiveKey(key)).toBe(false);
    }
  });

  it('covers the secret-bearing fields in PROJECT.md section 15', () => {
    for (const field of [
      'password',
      'token',
      'authorization',
      'cookie',
      'clientSecret',
      'apiKey',
    ]) {
      expect([...REDACTED_FIELD_NAMES]).toContain(field);
    }
  });
});

describe('deepRedact', () => {
  it('replaces a top-level secret', () => {
    expect(deepRedact({ token: 'abc' })).toEqual({ token: REDACTION_PLACEHOLDER });
  });

  it('replaces secrets at any depth', () => {
    expect(deepRedact({ a: { b: { c: { d: { accessToken: 'deep' } } } } })).toEqual({
      a: { b: { c: { d: { accessToken: REDACTION_PLACEHOLDER } } } },
    });
  });

  it('reaches into arrays of objects', () => {
    expect(deepRedact({ accounts: [{ token: 'a' }, { token: 'b' }] })).toEqual({
      accounts: [{ token: REDACTION_PLACEHOLDER }, { token: REDACTION_PLACEHOLDER }],
    });
  });

  it('leaves non-secret fields untouched at every depth', () => {
    expect(deepRedact({ a: { b: { password: 'x', postId: 'p1' } } })).toEqual({
      a: { b: { password: REDACTION_PLACEHOLDER, postId: 'p1' } },
    });
  });

  it('does not mutate the caller object', () => {
    const input = { token: 'keep-me' };
    deepRedact(input);
    expect(input.token).toBe('keep-me');
  });

  it('tolerates cycles', () => {
    const cyclic: Record<string, unknown> = { name: 'root' };
    cyclic.self = cyclic;
    expect(deepRedact(cyclic)).toEqual({ name: 'root', self: '[circular]' });
  });

  it('passes primitives through', () => {
    expect(deepRedact('a string')).toBe('a string');
    expect(deepRedact(42)).toBe(42);
    expect(deepRedact(null)).toBeNull();
  });

  it('does not recurse into class instances', () => {
    const date = new Date(0);
    expect(deepRedact({ at: date })).toEqual({ at: date });
  });
});

describe('createLogger', () => {
  it('emits the service name and a level on every line', () => {
    const { logger, lines } = captureLogger();
    logger.info({ stage: 'IMAGE' }, 'working');
    expect(parseLogLine(lineAt(lines, 0))).toMatchObject({
      service: 'test',
      level: 'info',
      stage: 'IMAGE',
      msg: 'working',
    });
  });

  it('redacts secrets so a token can never reach the log sink', () => {
    const { logger, lines } = captureLogger();
    logger.info({ accessToken: 'super-secret-value', postId: 'p1' }, 'connecting');
    const output = lines.join('\n');
    expect(output).not.toContain('super-secret-value');
    expect(output).toContain(REDACTION_PLACEHOLDER);
    // The non-secret field survives, so the line is still useful.
    expect(parseLogLine(lineAt(lines, 0))).toMatchObject({ postId: 'p1' });
  });

  it('redacts deeply nested secrets', () => {
    const { logger, lines } = captureLogger();
    logger.info(
      { account: { credentials: { refresh_token: 'nested-secret' }, platform: 'LINKEDIN' } },
      'account',
    );
    expect(lines.join('\n')).not.toContain('nested-secret');
    expect(parseLogLine(lineAt(lines, 0))).toMatchObject({ account: { platform: 'LINKEDIN' } });
  });

  it('redacts secrets nested inside arrays', () => {
    const { logger, lines } = captureLogger();
    logger.info({ socialAccounts: [{ access_token: 'tok-1' }, { access_token: 'tok-2' }] }, 'x');
    const output = lines.join('\n');
    expect(output).not.toContain('tok-1');
    expect(output).not.toContain('tok-2');
  });

  it('redacts secrets passed as base fields', () => {
    const lines: string[] = [];
    const logger = createLogger({
      destination: { write: (line: string) => lines.push(line) },
      base: { authorization: 'Bearer leak-me' },
    });
    logger.info('hello');
    expect(lines.join('')).not.toContain('leak-me');
  });

  it('redacts OAuth codes and full prompts', () => {
    const { logger, lines } = captureLogger();
    logger.info({ code: 'oauth-code-123', prompt: 'customer name is Jane' }, 'connect');
    const output = lines.join('');
    expect(output).not.toContain('oauth-code-123');
    expect(output).not.toContain('Jane');
  });

  it('respects the level', () => {
    const { logger, lines } = captureLogger('error');
    logger.info('should not appear');
    expect(lines).toHaveLength(0);
    logger.error('should appear');
    expect(lines).toHaveLength(1);
  });

  it('supports a silent level for tests', () => {
    const { logger, lines } = captureLogger('silent');
    logger.error('nope');
    expect(lines).toHaveLength(0);
  });

  it('adds base fields to every line', () => {
    const lines: string[] = [];
    const logger = createLogger({
      destination: { write: (line: string) => lines.push(line) },
      base: { requestId: 'req-1' },
    });
    logger.info('hello');
    expect(parseLogLine(lineAt(lines, 0))).toMatchObject({ requestId: 'req-1' });
  });

  it('still emits valid JSON for Error objects', () => {
    const { logger, lines } = captureLogger();
    logger.error({ err: new Error('provider timeout') }, 'generation failed');
    expect(parseLogLine(lineAt(lines, 0))).toMatchObject({
      level: 'error',
      msg: 'generation failed',
    });
  });
});

describe('toShutdownLogger', () => {
  it('bridges pino to the ShutdownLogger interface used by libs/common', () => {
    const { logger, lines } = captureLogger();
    const shutdownLogger = toShutdownLogger(logger);

    shutdownLogger.info({ app: 'media-worker', drain: 'lease' }, 'drain finished');
    shutdownLogger.warn({ app: 'media-worker' }, 'slow drain');
    shutdownLogger.error({ app: 'media-worker' }, 'drain failed');

    expect(parseLogLine(lineAt(lines, 0))).toMatchObject({
      app: 'media-worker',
      drain: 'lease',
      msg: 'drain finished',
      level: 'info',
    });
    expect(parseLogLine(lineAt(lines, 1))).toMatchObject({ level: 'warn' });
    expect(parseLogLine(lineAt(lines, 2))).toMatchObject({ level: 'error' });
  });
});
