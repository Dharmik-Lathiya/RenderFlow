import { ProviderError } from './providers';

/**
 * The shared runtime every real provider sits inside (PROJECT.md section 12
 * Phase 6: "Provider fallback and per-provider timeouts and rate limits").
 *
 * Four concerns, each of which is a place a provider gets it wrong when it is
 * left to each provider to handle:
 *
 *  - **Timeout.** A provider that hangs must not hold a leased job until the
 *    reaper decides its worker is dead. The abort is explicit rather than a
 *    `Promise.race`, so the socket is actually released rather than left
 *    dangling.
 *
 *  - **Classification.** The caller decides between retrying and refunding, so a
 *    provider must say which it meant. Anything not explicitly recognised is
 *    TRANSIENT: a 5xx nobody anticipated should be retried, while guessing
 *    PERMANENT refunds a user for our bug.
 *
 *  - **Fallback.** A provider that is down should not mean the job fails.
 *    Falling back is only safe for TRANSIENT errors - falling back from a
 *    refusal would route around a moderation decision.
 *
 *  - **Rate limit.** Per-provider concurrency, because the limit that matters is
 *    the upstream API's, not this process's.
 */

export interface RetryPolicy {
  /** Attempts per provider before moving to the next one in the chain. */
  attempts: number;
  /** Base backoff; attempt N waits `baseMs * 2^(N-1)`. */
  backoffMs: number;
}

/**
 * One attempt's budget.
 *
 * `attempts` counts attempts at THIS provider, not across the chain: three tries
 * at a flaky endpoint and three tries at a second endpoint are different budgets,
 * and conflating them means a chain of three providers gets nine calls.
 */
export const DEFAULT_POLICY: RetryPolicy = { attempts: 3, backoffMs: 250 };

/** Retries with backoff while another provider is still available. */
export const FALLBACK_ONLY: RetryPolicy = { attempts: 1, backoffMs: 0 };

export interface RuntimeOptions {
  /** Human-readable name, used in error messages and logs. */
  name: string;
  timeoutMs?: number;
  policy?: RetryPolicy;
  /** Records every attempt, for logging and metrics. */
  onAttempt?: (provider: string, attempt: number, ms: number, outcome: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_TIMEOUT_MS = 30_000;

const defaultSleep = (ms: number): Promise<void> =>
  ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `fn` under a timeout.
 *
 * Two things have to be true, and the obvious implementation gets only the first:
 *
 *  1. The signal must be handed to the work, so a hung HTTP call is actually
 *     aborted rather than left holding its socket. `Promise.race` on its own
 *     rejects the caller while the request keeps running.
 *  2. The timeout must reject **regardless** of whether the work reacts to the
 *     signal. Awaiting `fn(signal)` and aborting on a timer only works if the
 *     work cooperates; a provider that ignores its signal - or any future code
 *     that does - then hangs past its deadline and holds a leased job until the
 *     reaper declares the worker dead.
 */
export async function withTimeout<T>(
  name: string,
  timeoutMs: number,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();

  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ProviderError(`${name} timed out after ${timeoutMs}ms`, 'TRANSIENT'));
    }, timeoutMs);
  });

  const work = fn(controller.signal);

  // The work may reject AFTER the timeout already won the race - a connection
  // that drops seconds late. Without this the rejection is unhandled and takes
  // the process down with an ERR_UNHANDLED_REJECTION.
  work.catch(() => {});

  try {
    return await Promise.race([work, expiry]);
  } catch (error) {
    // Whichever side won, the operator needs the same answer: this was a
    // timeout. A work function that rejects on abort with its own message
    // ("aborted") would otherwise win the race and hide the actual cause.
    if (controller.signal.aborted && !(error instanceof ProviderError)) {
      throw new ProviderError(`${name} timed out after ${timeoutMs}ms`, 'TRANSIENT', {
        cause: error,
      });
    }
    throw error;
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/**
 * Turns an unknown thrown value into a classified provider error.
 *
 * The default is TRANSIENT, and that default is the point. An unrecognised
 * failure is more likely to be a bug or an outage than a refusal, and guessing
 * PERMANENT would refund a user for our fault. The cases listed here are the ones
 * where a retry genuinely cannot help.
 */
export function classify(name: string, error: unknown): ProviderError {
  if (error instanceof ProviderError) {
    return error;
  }

  const message = error instanceof Error ? error.message : String(error);
  const status = httpStatusOf(error);

  if (status !== undefined) {
    if (status === 429 || status >= 500) {
      return new ProviderError(`${name}: ${status} ${message}`, 'TRANSIENT', { cause: error });
    }
    if (status === 401 || status === 403) {
      // Credentials. Retrying with the same key burns the backoff budget and
      // ends in the same place.
      return new ProviderError(`${name}: not authorised (${status})`, 'PERMANENT', {
        cause: error,
      });
    }
    if (status === 400 || status === 422) {
      // The request itself is wrong. Resending it unchanged produces the same
      // answer, and charging the user for the attempt would be unfair.
      return new ProviderError(`${name}: request rejected (${status})`, 'PERMANENT', {
        cause: error,
      });
    }
  }

  return new ProviderError(`${name}: ${message}`, 'TRANSIENT', { cause: error });
}

interface HttpishError {
  status?: number;
  response?: { status?: number };
}

function httpStatusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const candidate = error as HttpishError;
  const status = candidate.status ?? candidate.response?.status;
  return typeof status === 'number' ? status : undefined;
}

/**
 * Calls one provider with retries, then gives up and rethrows.
 *
 * Only TRANSIENT errors are retried, and only ever within one provider's own
 * budget.
 */
export async function callWithRetries<T>(
  providerName: string,
  fn: (signal: AbortSignal) => Promise<T>,
  options: RuntimeOptions,
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const policy = options.policy ?? DEFAULT_POLICY;
  const sleep = options.sleep ?? defaultSleep;
  let lastError: ProviderError | undefined;

  for (let attempt = 1; attempt <= Math.max(1, policy.attempts); attempt += 1) {
    const startedAt = Date.now();

    try {
      const result = await withTimeout(providerName, timeoutMs, fn);
      options.onAttempt?.(providerName, attempt, Date.now() - startedAt, 'ok');
      return result;
    } catch (error) {
      const classified = classify(providerName, error);
      lastError = classified;
      options.onAttempt?.(providerName, attempt, Date.now() - startedAt, classified.classification);

      if (classified.classification === 'PERMANENT' || attempt === policy.attempts) {
        throw classified;
      }

      await sleep(policy.backoffMs * 2 ** (attempt - 1));
    }
  }

  // Unreachable: the loop either returns or throws. The guard is here so a future
  // edit to the loop cannot silently return `undefined` as a T.
  throw lastError ?? new ProviderError(`${providerName}: failed with no error`, 'TRANSIENT');
}

export interface FallbackOptions<T> extends Omit<RuntimeOptions, 'name'> {
  /** Providers in preference order; the first success wins. */
  providers: Array<{ name: string; call: (signal: AbortSignal) => Promise<T> }>;
  /** Retries per provider. Defaults to `FALLBACK_ONLY`. */
  policy?: RetryPolicy;
}

/**
 * Tries providers in order, returning the first success.
 *
 * Stops at the first PERMANENT error and rethrows it. That is the whole safety
 * property of a fallback chain: a refusal must not be routed around by asking
 * the next provider instead, or a moderation decision becomes advisory.
 *
 * The aggregate error names every provider that was tried. "It failed" with no
 * indication which endpoints were down is the version that wastes an afternoon.
 */
export async function withFallback<T>(
  options: FallbackOptions<T>,
): Promise<{ value: T; provider: string }> {
  if (options.providers.length === 0) {
    throw new ProviderError('no providers configured', 'PERMANENT');
  }

  const failures: string[] = [];

  for (const provider of options.providers) {
    try {
      // The provider's own name, not the chain's: when three endpoints are
      // tried, both the retry budget and the log line have to say which one.
      const value = await callWithRetries(provider.name, provider.call, {
        ...options,
        name: provider.name,
      });
      return { value, provider: provider.name };
    } catch (error) {
      const classified = classify(provider.name, error);
      failures.push(`${provider.name}: ${classified.message}`);

      if (classified.classification === 'PERMANENT') {
        throw new ProviderError(
          `${provider.name} refused and the fallback chain stopped: ${classified.message}`,
          'PERMANENT',
          { cause: error },
        );
      }
    }
  }

  throw new ProviderError(`every provider failed - ${failures.join('; ')}`, 'TRANSIENT');
}

/**
 * Concurrency limiter, per upstream API.
 *
 * A semaphore rather than a rate-per-second window: image and TTS providers
 * bill and throttle per concurrent job, and a fixed window lets a burst through
 * the instant it rolls over.
 */
export class ConcurrencyLimiter {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(`concurrency limit must be a positive integer, got ${limit}`);
    }
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => {
        this.waiting.push(resolve);
      });
    }

    this.active += 1;

    try {
      return await fn();
    } finally {
      this.active -= 1;
      // Releasing the next waiter in `finally`, not after the result: a provider
      // that throws must still free its slot, or the limit ratchets down one
      // slot per failure until nothing can run.
      this.waiting.shift()?.();
    }
  }

  /** In-flight calls. Exposed for metrics and for tests that prove it caps. */
  get inFlight(): number {
    return this.active;
  }
}
