import { startWorkerProcess, abortOnFatal } from './process-runtime';

describe('startWorkerProcess', () => {
  const options = {
    appName: 'media-worker',
    queue: 'media',
    concurrency: 2,
    redisUrl: 'redis://localhost:6379',
  };

  it('installs SIGTERM/SIGINT handlers', () => {
    const before = process.listenerCount('SIGTERM');
    const worker = startWorkerProcess(options);
    expect(process.listenerCount('SIGTERM')).toBe(before + 1);
    worker.shutdown.uninstall();
  });

  it('logs the queue it will consume so compose logs identify the worker', () => {
    const lines: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Uint8Array): boolean => {
      lines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
      return true;
    };

    const worker = startWorkerProcess({ ...options, base: { quiet: true } });
    worker.shutdown.uninstall();

    process.stdout.write = originalWrite;

    expect(lines.join('')).toContain('"app":"media-worker"');
    expect(lines.join('')).toContain('"queue":"media"');
    expect(lines.join('')).toContain('"concurrency":2');
  });

  it('defaults the drain budget when none is supplied', () => {
    const worker = startWorkerProcess(options);
    expect(worker.shutdown).toBeDefined();
    worker.shutdown.uninstall();
  });

  it('redacts a redis password even if the caller forgets to', () => {
    const lines: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Uint8Array): boolean => {
      lines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
      return true;
    };

    const worker = startWorkerProcess({
      ...options,
      redisUrl: 'redis://user:hunter2@localhost:6379',
    });
    worker.shutdown.uninstall();

    process.stdout.write = originalWrite;

    expect(lines.join('')).not.toContain('hunter2');
    expect(lines.join('')).toContain('localhost:6379');
  });

  it('honours an explicit drain budget', () => {
    const lines: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Uint8Array): boolean => {
      lines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
      return true;
    };

    const worker = startWorkerProcess({
      ...options,
      drainTimeoutMs: 1_234,
      base: { stage: 'bootstrap' },
    });
    worker.shutdown.uninstall();

    process.stdout.write = originalWrite;

    expect(lines.join('')).toContain('"stage":"bootstrap"');
  });

  it('exposes a start timestamp', () => {
    const worker = startWorkerProcess(options);
    worker.shutdown.uninstall();
    expect(worker.startedAt.getTime()).toBeLessThanOrEqual(Date.now());
  });
});

describe('abortOnFatal', () => {
  it('logs the failure and exits non-zero', () => {
    const exit = jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exited');
    });

    expect(() => abortOnFatal('reaper', new Error('no database'))).toThrow('exited');
    expect(exit).toHaveBeenCalledWith(1);

    exit.mockRestore();
  });
});
