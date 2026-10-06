/**
 * Process lifecycle helper shared by the API and every worker.
 *
 * AGENTS.md section 6 rule 8: "Graceful shutdown: on SIGTERM stop consuming,
 * finish or release the current job back to the queue." PROJECT.md section 9.8
 * makes this a hard requirement, so it lives in one tested place instead of
 * being copy-pasted into eight entry points.
 *
 * Behaviour:
 * - drains run LIFO (last registered finishes first), so a worker closes its
 *   queue connection after it has released in-flight jobs, not before;
 * - a failing or hanging drain never prevents the others from running;
 * - the whole shutdown is bounded by a single deadline;
 * - `run()` is idempotent, so two signals arriving together exit once.
 */

export interface ShutdownLogger {
  info(context: Record<string, unknown>, message?: string): void;
  warn(context: Record<string, unknown>, message?: string): void;
  error(context: Record<string, unknown>, message?: string): void;
}

export type DrainFn = () => Promise<void> | void;

export interface GracefulShutdownOptions {
  /** Application name, included in every log line. */
  name: string;
  logger: ShutdownLogger;
  /** Total budget for all drains combined. Defaults to 15s. */
  drainTimeoutMs?: number;
  /** Signals to trap. Defaults to SIGTERM + SIGINT. */
  signals?: readonly NodeJS.Signals[];
  /** Injection seam for tests; defaults to `process.exit`. */
  exit?: (code: number) => void;
}

export interface GracefulShutdown {
  install(): void;
  uninstall(): void;
  registerDrain(name: string, drain: DrainFn): void;
  isShuttingDown(): boolean;
  /** Runs every registered drain. Exposed so tests can drive it directly. */
  run(signal?: string): Promise<void>;
}

export const DEFAULT_DRAIN_TIMEOUT_MS = 15_000;
export const DEFAULT_SHUTDOWN_SIGNALS: readonly NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];

interface RegisteredDrain {
  name: string;
  drain: DrainFn;
}

function withDeadline<T>(promise: Promise<T>, remainingMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} did not finish within ${remainingMs}ms`));
    }, remainingMs);
    // Do not hold the event loop open purely for the timeout.
    timer.unref?.();

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (reason: unknown) => {
        clearTimeout(timer);
        // Preserve the original error when possible so stack traces survive.
        reject(reason instanceof Error ? reason : new Error(String(reason)));
      },
    );
  });
}

export function createGracefulShutdown(options: GracefulShutdownOptions): GracefulShutdown {
  const {
    name,
    logger,
    drainTimeoutMs = DEFAULT_DRAIN_TIMEOUT_MS,
    signals = DEFAULT_SHUTDOWN_SIGNALS,
    exit,
  } = options;

  const terminate = exit ?? ((code: number): void => process.exit(code));
  const drains: RegisteredDrain[] = [];
  const handlers = new Map<NodeJS.Signals, () => void>();
  let shuttingDown = false;
  let inFlight: Promise<void> | null = null;

  async function runAllDrains(): Promise<void> {
    // Snapshot + reverse: last registered is closest to the process and should
    // be released first (close the connection, then release the work).
    const pending = [...drains].reverse();
    const deadline = Date.now() + drainTimeoutMs;
    const failed: string[] = [];

    for (const entry of pending) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        failed.push(`${entry.name}(timeout)`);
        logger.error({ app: name, drain: entry.name }, 'no time left in shutdown budget');
        continue;
      }
      try {
        await withDeadline(Promise.resolve().then(entry.drain), remaining, entry.name);
        logger.info({ app: name, drain: entry.name }, 'drain finished');
      } catch (error) {
        failed.push(entry.name);
        logger.error({ app: name, drain: entry.name, err: error }, 'drain failed');
      }
    }

    if (failed.length > 0) {
      logger.warn({ app: name, failed }, 'graceful shutdown finished with failed drains');
    }
  }

  async function run(signal = 'MANUAL'): Promise<void> {
    if (inFlight) {
      return inFlight;
    }
    shuttingDown = true;
    logger.info({ app: name, signal }, 'graceful shutdown started');
    inFlight = runAllDrains().then(() => {
      logger.info({ app: name, signal }, 'graceful shutdown complete');
    });
    return inFlight;
  }

  function onSignal(signal: NodeJS.Signals): void {
    logger.info({ app: name, signal }, 'received termination signal');
    void run(signal).then(() => {
      terminate(0);
    });
  }

  return {
    install(): void {
      for (const signal of signals) {
        const handler = (): void => onSignal(signal);
        handlers.set(signal, handler);
        process.on(signal, handler);
      }
      logger.info({ app: name, signals: [...signals] }, 'shutdown handlers installed');
    },

    uninstall(): void {
      for (const [signal, handler] of handlers) {
        process.off(signal, handler);
      }
      handlers.clear();
    },

    registerDrain(drainName: string, drain: DrainFn): void {
      if (shuttingDown) {
        // Registered after SIGTERM: run it now so the resource still gets closed.
        void Promise.resolve()
          .then(drain)
          .catch((error: unknown) => {
            logger.error({ app: name, drain: drainName, err: error }, 'late drain failed');
          });
        return;
      }
      drains.push({ name: drainName, drain });
    },

    isShuttingDown(): boolean {
      return shuttingDown;
    },

    run,
  };
}
