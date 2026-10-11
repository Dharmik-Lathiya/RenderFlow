import { ProviderError } from './providers';
import {
  ConcurrencyLimiter,
  FALLBACK_ONLY,
  callWithRetries,
  classify,
  withFallback,
  withTimeout,
} from './runtime';

/**
 * The provider runtime: timeouts, classification, retries, fallback, limits.
 *
 * These are the rules that decide whether a user gets refunded or retried, so
 * each test below names the mistake it is preventing rather than just the
 * branch it covers.
 */
describe('classify', () => {
  it('passes an already-classified error through unchanged', () => {
    const original = new ProviderError('nsfw', 'PERMANENT');
    expect(classify('image', original)).toBe(original);
  });

  it('treats 429 and 5xx as transient', () => {
    expect(classify('image', { status: 429 }).classification).toBe('TRANSIENT');
    expect(classify('image', { status: 500 }).classification).toBe('TRANSIENT');
    expect(classify('image', { status: 503 }).classification).toBe('TRANSIENT');
  });

  it('reads a status off a fetch-style response too', () => {
    expect(classify('image', { response: { status: 401 } }).classification).toBe('PERMANENT');
  });

  it('treats bad credentials as permanent', () => {
    // Retrying with the same key burns the backoff budget and ends up exactly
    // where it started, while the job's credits stay reserved.
    expect(classify('image', { status: 401 }).classification).toBe('PERMANENT');
    expect(classify('image', { status: 403 }).classification).toBe('PERMANENT');
  });

  it('treats a rejected request as permanent', () => {
    // Resending an identical bad request produces an identical rejection, and
    // the user should not pay for the retries.
    expect(classify('image', { status: 400 }).classification).toBe('PERMANENT');
    expect(classify('image', { status: 422 }).classification).toBe('PERMANENT');
  });

  it('defaults to TRANSIENT for anything unrecognised', () => {
    // The load-bearing default. An unrecognised failure is more likely a bug or
    // an outage than a refusal, and guessing PERMANENT would refund a user for
    // our fault.
    expect(classify('image', new Error('ECONNRESET')).classification).toBe('TRANSIENT');
    expect(classify('image', 'a string').classification).toBe('TRANSIENT');
    expect(classify('image', null).classification).toBe('TRANSIENT');
    expect(classify('image', { status: 418 }).classification).toBe('TRANSIENT');
  });

  it('names the provider so a chain failure is diagnosable', () => {
    expect(classify('replicate', new Error('boom')).message).toMatch(/^replicate:/);
  });
});

describe('withTimeout', () => {
  it('returns the value when the call is fast enough', async () => {
    await expect(withTimeout('p', 1_000, async () => 'ok')).resolves.toBe('ok');
  });

  it('aborts the signal it was given, not just the promise', async () => {
    // A `Promise.race` would reject while the underlying request kept running
    // and kept its socket. The provider needs the signal to actually stop.
    let sawAbort = false;
    const work = (signal: AbortSignal) =>
      new Promise<string>((resolve, reject) => {
        signal.addEventListener('abort', () => {
          sawAbort = true;
          reject(new Error('aborted'));
        });
        setTimeout(() => resolve('too late'), 5_000);
      });

    await expect(withTimeout('p', 20, work)).rejects.toThrow(/timed out/);
    expect(sawAbort).toBe(true);
  });

  it('reports a timeout as transient so the job is retried, not refunded', async () => {
    await expect(withTimeout('p', 20, () => new Promise(() => {}))).rejects.toMatchObject({
      classification: 'TRANSIENT',
    });
  });

  it('lets a real error through rather than dressing it up as a timeout', async () => {
    const error = new ProviderError('refused', 'PERMANENT');
    await expect(withTimeout('p', 1_000, async () => Promise.reject(error))).rejects.toBe(error);
  });
});

describe('callWithRetries', () => {
  const noSleep = async (): Promise<void> => {};

  it('returns the first success', async () => {
    const result = await callWithRetries('p', async () => 'ok', { name: 'p', sleep: noSleep });
    expect(result).toBe('ok');
  });

  it('retries a transient failure and then succeeds', async () => {
    let calls = 0;
    const result = await callWithRetries(
      'p',
      async () => {
        calls += 1;
        if (calls < 3) throw new ProviderError('timeout', 'TRANSIENT');
        return 'ok';
      },
      { name: 'p', policy: { attempts: 3, backoffMs: 1 }, sleep: noSleep },
    );

    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });

  it('does not retry a permanent failure', async () => {
    let calls = 0;
    await expect(
      callWithRetries(
        'p',
        async () => {
          calls += 1;
          throw new ProviderError('refused', 'PERMANENT');
        },
        { name: 'p', policy: { attempts: 5, backoffMs: 1 }, sleep: noSleep },
      ),
    ).rejects.toMatchObject({ classification: 'PERMANENT' });
    expect(calls).toBe(1);
  });

  it('gives up after the configured number of attempts', async () => {
    let calls = 0;
    await expect(
      callWithRetries(
        'p',
        async () => {
          calls += 1;
          throw new ProviderError('down', 'TRANSIENT');
        },
        { name: 'p', policy: { attempts: 2, backoffMs: 1 }, sleep: noSleep },
      ),
    ).rejects.toThrow(/down/);
    expect(calls).toBe(2);
  });

  it('backs off exponentially', async () => {
    const waits: number[] = [];
    await expect(
      callWithRetries(
        'p',
        async () => {
          throw new ProviderError('down', 'TRANSIENT');
        },
        {
          name: 'p',
          policy: { attempts: 4, backoffMs: 10 },
          sleep: async (ms) => {
            waits.push(ms);
          },
        },
      ),
    ).rejects.toThrow();

    // 10, 20, 40 - not 10, 10, 10. A fixed wait against a struggling endpoint is
    // how one outage turns into an outage against every worker at once.
    expect(waits).toEqual([10, 20, 40]);
  });

  it('reports every attempt', async () => {
    const seen: string[] = [];
    await expect(
      callWithRetries(
        'p',
        async () => {
          throw new ProviderError('down', 'TRANSIENT');
        },
        {
          name: 'p',
          policy: { attempts: 2, backoffMs: 0 },
          sleep: noSleep,
          onAttempt: (provider, _attempt, _ms, outcome) => seen.push(`${provider}:${outcome}`),
        },
      ),
    ).rejects.toThrow();

    expect(seen).toEqual(['p:TRANSIENT', 'p:TRANSIENT']);
  });
});

describe('withFallback', () => {
  const noSleep = async (): Promise<void> => {};

  it('uses the first provider when it works', async () => {
    let secondCalled = false;
    const result = await withFallback({
      providers: [
        { name: 'a', call: async () => 'from-a' },
        {
          name: 'b',
          call: async () => {
            secondCalled = true;
            return 'from-b';
          },
        },
      ],
    });

    expect(result).toEqual({ value: 'from-a', provider: 'a' });
    expect(secondCalled).toBe(false);
  });

  it('moves to the next provider when the first is down', async () => {
    const result = await withFallback({
      providers: [
        {
          name: 'a',
          call: async () => {
            throw new ProviderError('unreachable', 'TRANSIENT');
          },
        },
        { name: 'b', call: async () => 'from-b' },
      ],
      policy: FALLBACK_ONLY,
      sleep: noSleep,
    });

    expect(result).toEqual({ value: 'from-b', provider: 'b' });
  });

  it('stops at a refusal rather than routing around it', async () => {
    // The safety property of the whole chain: a moderation decision must not
    // become advisory because the second provider was more permissive.
    let secondCalled = false;
    await expect(
      withFallback({
        providers: [
          {
            name: 'a',
            call: async () => {
              throw new ProviderError('content refused', 'PERMANENT');
            },
          },
          {
            name: 'b',
            call: async () => {
              secondCalled = true;
              return 'from-b';
            },
          },
        ],
        sleep: noSleep,
      }),
    ).rejects.toMatchObject({ classification: 'PERMANENT' });

    expect(secondCalled).toBe(false);
  });

  it('names every provider it tried when they all fail', async () => {
    // "It failed" with no indication which endpoints were down is the version
    // that wastes an afternoon.
    await expect(
      withFallback({
        providers: [
          {
            name: 'replicate',
            call: async () => {
              throw new ProviderError('503', 'TRANSIENT');
            },
          },
          {
            name: 'fal',
            call: async () => {
              throw new ProviderError('timeout', 'TRANSIENT');
            },
          },
        ],
        policy: FALLBACK_ONLY,
        sleep: noSleep,
      }),
    ).rejects.toThrow(/replicate.*fal/s);
  });

  it('reports the whole chain as transient, so the job is retried not refunded', async () => {
    await expect(
      withFallback({
        providers: [
          {
            name: 'a',
            call: async () => {
              throw new ProviderError('down', 'TRANSIENT');
            },
          },
        ],
        policy: FALLBACK_ONLY,
        sleep: noSleep,
      }),
    ).rejects.toMatchObject({ classification: 'TRANSIENT' });
  });

  it('refuses an empty chain rather than returning undefined', async () => {
    await expect(withFallback({ providers: [] })).rejects.toMatchObject({
      classification: 'PERMANENT',
    });
  });

  it('gives each provider its own retry budget', async () => {
    const calls: string[] = [];
    await expect(
      withFallback({
        providers: [
          {
            name: 'a',
            call: async () => {
              calls.push('a');
              throw new ProviderError('down', 'TRANSIENT');
            },
          },
          {
            name: 'b',
            call: async () => {
              calls.push('b');
              throw new ProviderError('down', 'TRANSIENT');
            },
          },
        ],
        // Three providers at three attempts each would be nine upstream calls for
        // one job; conflating the budgets is how a chain turns an outage into a
        // bill.
        policy: { attempts: 2, backoffMs: 0 },
        sleep: noSleep,
      }),
    ).rejects.toThrow();

    expect(calls).toEqual(['a', 'a', 'b', 'b']);
  });
});

describe('ConcurrencyLimiter', () => {
  it('never runs more than the limit at once', async () => {
    const limiter = new ConcurrencyLimiter(2);
    let peak = 0;

    const work = async () => {
      peak = Math.max(peak, limiter.inFlight);
      await new Promise((resolve) => {
        setTimeout(resolve, 5);
      });
    };

    await Promise.all(Array.from({ length: 8 }, () => limiter.run(work)));

    expect(peak).toBeLessThanOrEqual(2);
  });

  it('frees its slot when the work throws', async () => {
    // Releasing in `finally`, not after the result: otherwise the limit ratchets
    // down by one per failure until nothing can run at all.
    const limiter = new ConcurrencyLimiter(1);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(
        limiter.run(async () => {
          throw new ProviderError('boom', 'TRANSIENT');
        }),
      ).rejects.toThrow();
    }

    await expect(limiter.run(async () => 'still works')).resolves.toBe('still works');
    expect(limiter.inFlight).toBe(0);
  });

  it('rejects a nonsensical limit at construction', () => {
    expect(() => new ConcurrencyLimiter(0)).toThrow(/positive integer/);
    expect(() => new ConcurrencyLimiter(1.5)).toThrow(/positive integer/);
  });
});
