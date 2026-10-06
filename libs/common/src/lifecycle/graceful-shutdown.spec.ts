import {
  DEFAULT_DRAIN_TIMEOUT_MS,
  createGracefulShutdown,
  type ShutdownLogger,
} from './graceful-shutdown';

function createFakeLogger(): jest.Mocked<ShutdownLogger> {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
}

describe('createGracefulShutdown', () => {
  it('exposes a sensible default drain budget', () => {
    expect(DEFAULT_DRAIN_TIMEOUT_MS).toBe(15_000);
  });

  it('runs drains in LIFO order so nested resources close correctly', async () => {
    const order: string[] = [];
    const shutdown = createGracefulShutdown({ name: 'test', logger: createFakeLogger() });

    shutdown.registerDrain('queue', () => {
      order.push('queue');
    });
    shutdown.registerDrain('lease', async () => {
      order.push('lease');
    });
    shutdown.registerDrain('http', () => {
      order.push('http');
    });

    await shutdown.run('TEST');

    expect(order).toEqual(['http', 'lease', 'queue']);
  });

  it('awaits async drains before returning', async () => {
    const logger = createFakeLogger();
    const shutdown = createGracefulShutdown({ name: 'test', logger });
    let finished = false;

    shutdown.registerDrain('slow', async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      finished = true;
    });

    await shutdown.run();
    expect(finished).toBe(true);
  });

  it('is idempotent: two signals only drain once', async () => {
    const drain = jest.fn();
    const shutdown = createGracefulShutdown({ name: 'test', logger: createFakeLogger() });
    shutdown.registerDrain('once', drain);

    await Promise.all([shutdown.run('SIGTERM'), shutdown.run('SIGINT')]);
    await shutdown.run('SIGTERM');

    expect(drain).toHaveBeenCalledTimes(1);
  });

  it('keeps draining after a failure and reports it', async () => {
    const logger = createFakeLogger();
    const shutdown = createGracefulShutdown({ name: 'test', logger });
    const survivor = jest.fn();

    shutdown.registerDrain('survivor', survivor);
    shutdown.registerDrain('exploding', () => {
      throw new Error('boom');
    });

    await expect(shutdown.run()).resolves.toBeUndefined();

    expect(survivor).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ app: 'test', drain: 'exploding' }),
      'drain failed',
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ failed: ['exploding'] }),
      'graceful shutdown finished with failed drains',
    );
  });

  it('treats a rejected async drain as a failure, not a crash', async () => {
    const logger = createFakeLogger();
    const shutdown = createGracefulShutdown({ name: 'test', logger });

    shutdown.registerDrain('rejecting', async () => {
      throw new Error('async boom');
    });

    await expect(shutdown.run()).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it('bounds a hanging drain by the shutdown budget', async () => {
    const logger = createFakeLogger();
    const shutdown = createGracefulShutdown({
      name: 'test',
      logger,
      drainTimeoutMs: 20,
    });

    shutdown.registerDrain('hangs', () => new Promise<void>(() => {}));
    const after = jest.fn();
    shutdown.registerDrain('after', after);

    await shutdown.run();

    // The hanging drain was abandoned and the next drain still ran.
    expect(after).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ drain: 'hangs' }),
      'drain failed',
    );
  });

  it('skips remaining drains once the budget is exhausted', async () => {
    const logger = createFakeLogger();
    const shutdown = createGracefulShutdown({ name: 'test', logger, drainTimeoutMs: 0 });
    const never = jest.fn();

    shutdown.registerDrain('never', never);

    await shutdown.run();

    expect(never).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ drain: 'never' }),
      'no time left in shutdown budget',
    );
  });

  it('reports whether shutdown has started', async () => {
    const shutdown = createGracefulShutdown({ name: 'test', logger: createFakeLogger() });
    expect(shutdown.isShuttingDown()).toBe(false);
    await shutdown.run();
    expect(shutdown.isShuttingDown()).toBe(true);
  });

  it('runs a drain registered after shutdown started', async () => {
    const shutdown = createGracefulShutdown({ name: 'test', logger: createFakeLogger() });
    await shutdown.run();

    const late = jest.fn();
    shutdown.registerDrain('late', late);

    // Registration during shutdown is executed immediately rather than dropped.
    await Promise.resolve();
    await Promise.resolve();
    expect(late).toHaveBeenCalledTimes(1);
  });

  describe('signal handling', () => {
    it('installs and removes handlers without leaking listeners', () => {
      const shutdown = createGracefulShutdown({
        name: 'test',
        logger: createFakeLogger(),
        signals: ['SIGTERM'],
      });
      const before = process.listenerCount('SIGTERM');

      shutdown.install();
      expect(process.listenerCount('SIGTERM')).toBe(before + 1);

      shutdown.uninstall();
      expect(process.listenerCount('SIGTERM')).toBe(before);
    });

    it('drains and exits 0 on SIGTERM', async () => {
      const logger = createFakeLogger();
      const exit = jest.fn();
      const drain = jest.fn();
      const shutdown = createGracefulShutdown({
        name: 'test',
        logger,
        exit,
        signals: ['SIGTERM'],
      });
      shutdown.registerDrain('in-flight-job', drain);
      shutdown.install();

      process.emit('SIGTERM');
      await shutdown.run('SIGTERM');

      expect(drain).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledWith(0);

      shutdown.uninstall();
    });
  });
});
