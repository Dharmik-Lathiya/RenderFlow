import { ApiClientError, IDEMPOTENCY_KEY_HEADER, createRenderFlowClient } from './client';
import type { LivenessResponse, Paginated } from './types';

const BASE_URL = 'http://api.test/api/v1';

interface RecordedCall {
  url: string;
  init: RequestInit;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function fakeFetch(responses: Response[] | ((call: RecordedCall) => Response)) {
  const calls: RecordedCall[] = [];
  const impl = async (url: string, init?: RequestInit): Promise<Response> => {
    const call = { url, init: init ?? {} };
    calls.push(call);
    if (typeof responses === 'function') {
      return responses(call);
    }
    const next = responses.shift();
    if (!next) {
      throw new Error('fakeFetch ran out of queued responses');
    }
    return next;
  };
  return { impl, calls };
}

describe('createRenderFlowClient', () => {
  it('requires a fetch implementation', () => {
    expect(() => createRenderFlowClient({ baseUrl: BASE_URL, fetchImpl: undefined })).not.toThrow();
    expect(() => createRenderFlowClient({ baseUrl: BASE_URL, fetchImpl: 'nope' as never })).toThrow(
      TypeError,
    );
  });

  it('prefixes paths onto the versioned base url', async () => {
    const { impl, calls } = fakeFetch([jsonResponse({ ok: true })]);
    const client = createRenderFlowClient({ baseUrl: BASE_URL, fetchImpl: impl });

    await client.get('/credits');

    expect(calls[0]?.url).toBe('http://api.test/api/v1/credits');
  });

  it('tolerates a base url with a trailing slash and a path without a leading slash', async () => {
    const { impl, calls } = fakeFetch([jsonResponse({ ok: true })]);
    const client = createRenderFlowClient({ baseUrl: `${BASE_URL}/`, fetchImpl: impl });

    await client.get('credits');

    expect(calls[0]?.url).toBe('http://api.test/api/v1/credits');
  });

  it('serialises query parameters and skips undefined values', async () => {
    const { impl, calls } = fakeFetch([
      jsonResponse({ items: [], total: 0, page: 1, pageSize: 20 }),
    ]);
    const client = createRenderFlowClient({ baseUrl: BASE_URL, fetchImpl: impl });

    await client.get<Paginated<never>>('/jobs', {
      query: { status: 'FAILED', page: 2, cursor: undefined },
    });

    const url = new URL(calls[0]?.url ?? '');
    expect(url.searchParams.get('status')).toBe('FAILED');
    expect(url.searchParams.get('page')).toBe('2');
    expect(url.searchParams.has('cursor')).toBe(false);
  });

  it('sends JSON bodies with the right content type', async () => {
    const { impl, calls } = fakeFetch([jsonResponse({ id: 'post-1' })]);
    const client = createRenderFlowClient({ baseUrl: BASE_URL, fetchImpl: impl });

    await client.post('/posts', { caption: 'hello' });

    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(calls[0]?.init.body).toBe(JSON.stringify({ caption: 'hello' }));
  });

  it('sends an Idempotency-Key header when one is supplied', async () => {
    const { impl, calls } = fakeFetch([jsonResponse({ id: 'job-1' })]);
    const client = createRenderFlowClient({ baseUrl: BASE_URL, fetchImpl: impl });

    await client.post('/posts/p1/generate', { type: 'REEL' }, { idempotencyKey: 'req-abc-123' });

    expect((calls[0]?.init.headers as Record<string, string>)[IDEMPOTENCY_KEY_HEADER]).toBe(
      'req-abc-123',
    );
  });

  it('omits the idempotency header otherwise', async () => {
    const { impl, calls } = fakeFetch([jsonResponse({})]);
    const client = createRenderFlowClient({ baseUrl: BASE_URL, fetchImpl: impl });

    await client.get('/me');

    expect(
      (calls[0]?.init.headers as Record<string, string>)[IDEMPOTENCY_KEY_HEADER],
    ).toBeUndefined();
  });

  it('attaches a bearer token when a token source is provided (mobile)', async () => {
    const { impl, calls } = fakeFetch([jsonResponse({})]);
    const client = createRenderFlowClient({
      baseUrl: BASE_URL,
      fetchImpl: impl,
      getToken: async () => 'jwt-abc',
      withCredentials: false,
    });

    await client.get('/me');

    expect((calls[0]?.init.headers as Record<string, string>).Authorization).toBe('Bearer jwt-abc');
    expect(calls[0]?.init.credentials).toBe('omit');
  });

  it('sends credentials by default so cookie auth works (web)', async () => {
    const { impl, calls } = fakeFetch([jsonResponse({})]);
    const client = createRenderFlowClient({ baseUrl: BASE_URL, fetchImpl: impl });

    await client.get('/me');

    expect(calls[0]?.init.credentials).toBe('include');
  });

  it('does not attach an Authorization header when no token is available', async () => {
    const { impl, calls } = fakeFetch([jsonResponse({})]);
    const client = createRenderFlowClient({
      baseUrl: BASE_URL,
      fetchImpl: impl,
      getToken: () => null,
    });

    await client.get('/me');

    expect((calls[0]?.init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('merges default and per-request headers', async () => {
    const { impl, calls } = fakeFetch([jsonResponse({})]);
    const client = createRenderFlowClient({
      baseUrl: BASE_URL,
      fetchImpl: impl,
      headers: { 'X-Client': 'web' },
    });

    await client.get('/me', { headers: { 'X-Request-Source': 'calendar' } });

    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['X-Client']).toBe('web');
    expect(headers['X-Request-Source']).toBe('calendar');
  });

  it('covers patch and post verbs', async () => {
    const { impl, calls } = fakeFetch([jsonResponse({}), jsonResponse({})]);
    const client = createRenderFlowClient({ baseUrl: BASE_URL, fetchImpl: impl });

    await client.patch('/posts/p1', { caption: 'edited' });
    await client.post('/posts/p1/approve');

    expect(calls[0]?.init.method).toBe('PATCH');
    expect(calls[1]?.init.method).toBe('POST');
  });

  it('returns undefined for 204 responses', async () => {
    const { impl } = fakeFetch([new Response(null, { status: 204 })]);
    const client = createRenderFlowClient({ baseUrl: BASE_URL, fetchImpl: impl });

    await expect(client.delete('/brands/b1')).resolves.toBeUndefined();
  });

  it('returns non-JSON bodies as text', async () => {
    const { impl } = fakeFetch([
      new Response('pong', { headers: { 'content-type': 'text/plain' } }),
    ]);
    const client = createRenderFlowClient({ baseUrl: BASE_URL, fetchImpl: impl });

    await expect(client.get('/ping')).resolves.toBe('pong');
  });
});

describe('ApiClientError', () => {
  it('preserves the API error envelope', async () => {
    const { impl } = fakeFetch([
      jsonResponse(
        {
          code: 'INSUFFICIENT_CREDITS',
          message: 'Not enough credits',
          details: { required: 30, available: 12 },
        },
        402,
      ),
    ]);
    const client = createRenderFlowClient({ baseUrl: BASE_URL, fetchImpl: impl });

    const error = await client.post('/posts/p1/generate').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiClientError);
    const apiError = error as ApiClientError;
    expect(apiError.status).toBe(402);
    expect(apiError.code).toBe('INSUFFICIENT_CREDITS');
    expect(apiError.message).toBe('Not enough credits');
    expect(apiError.details).toEqual({ required: 30, available: 12 });
  });

  it('flags insufficient credits for the upsell modal', async () => {
    const { impl } = fakeFetch([
      jsonResponse({ code: 'INSUFFICIENT_CREDITS', message: 'no' }, 402),
    ]);
    const client = createRenderFlowClient({ baseUrl: BASE_URL, fetchImpl: impl });

    const error = (await client.get('/credits').catch((e: unknown) => e)) as ApiClientError;

    expect(error.isInsufficientCredits).toBe(true);
    expect(error.isRetryable).toBe(false);
  });

  it('classifies 429 and 5xx as retryable', async () => {
    const { impl } = fakeFetch([
      jsonResponse({ code: 'RATE_LIMITED', message: 'slow down' }, 429),
      jsonResponse({ code: 'PROVIDER_TRANSIENT_ERROR', message: 'upstream' }, 503),
    ]);
    const client = createRenderFlowClient({ baseUrl: BASE_URL, fetchImpl: impl });

    const limited = (await client.get('/a').catch((e: unknown) => e)) as ApiClientError;
    const unavailable = (await client.get('/b').catch((e: unknown) => e)) as ApiClientError;

    expect(limited.isRetryable).toBe(true);
    expect(unavailable.isRetryable).toBe(true);
  });

  it('falls back when the error body is not the documented envelope', async () => {
    const { impl } = fakeFetch([new Response('<html>502</html>', { status: 502 })]);
    const client = createRenderFlowClient({ baseUrl: BASE_URL, fetchImpl: impl });

    const error = (await client.get('/a').catch((e: unknown) => e)) as ApiClientError;

    expect(error.code).toBe('UNKNOWN_ERROR');
    expect(error.message).toContain('502');
  });

  it('falls back when the error body carries a code but no message', async () => {
    const { impl } = fakeFetch([jsonResponse({ code: 'INTERNAL_ERROR' }, 500)]);
    const client = createRenderFlowClient({ baseUrl: BASE_URL, fetchImpl: impl });

    const error = (await client.get('/a').catch((e: unknown) => e)) as ApiClientError;

    expect(error.code).toBe('INTERNAL_ERROR');
    expect(error.message).toContain('500');
  });

  it('wraps transport failures', async () => {
    const impl = async (): Promise<Response> => {
      throw new TypeError('Failed to fetch');
    };
    const client = createRenderFlowClient({ baseUrl: BASE_URL, fetchImpl: impl });

    const error = (await client.get('/me').catch((e: unknown) => e)) as ApiClientError;

    expect(error).toBeInstanceOf(ApiClientError);
    expect(error.status).toBe(503);
    expect(error.code).toBe('NETWORK_ERROR');
  });

  it('surfaces a timeout as a 408 rather than a generic network error', async () => {
    // A fetch that never settles until its signal aborts, like a real hanging call.
    const impl = (_url: string, init?: RequestInit): Promise<Response> =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError')),
        );
      });

    const client = createRenderFlowClient({ baseUrl: BASE_URL, fetchImpl: impl, timeoutMs: 10 });

    const error = (await client.get('/slow').catch((e: unknown) => e)) as ApiClientError;

    expect(error.status).toBe(408);
    expect(error.code).toBe('TIMEOUT');
  });

  it('respects an already-aborted caller signal', async () => {
    const controller = new AbortController();
    controller.abort();
    let receivedSignal: AbortSignal | undefined;

    const impl = async (_url: string, init?: RequestInit): Promise<Response> => {
      receivedSignal = init?.signal ?? undefined;
      return jsonResponse({});
    };

    const client = createRenderFlowClient({ baseUrl: BASE_URL, fetchImpl: impl });
    await client.get('/me', { signal: controller.signal });

    expect(receivedSignal?.aborted).toBe(true);
  });

  it('propagates a caller abort that fires mid-flight', async () => {
    const controller = new AbortController();

    const impl = (_url: string, init?: RequestInit): Promise<Response> =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        });
        controller.abort();
      });

    const client = createRenderFlowClient({ baseUrl: BASE_URL, fetchImpl: impl });

    const error = (await client
      .get('/me', { signal: controller.signal })
      .catch((e: unknown) => e)) as ApiClientError;

    expect(error.status).toBe(408);
  });
});

describe('health helpers', () => {
  it('calls health at the server root, outside the versioned prefix', async () => {
    const { impl, calls } = fakeFetch([
      jsonResponse({ status: 'ok', service: 'api', uptimeSeconds: 1 } satisfies LivenessResponse),
      jsonResponse({
        status: 'ok',
        checks: { database: 'up', redis: 'up', storage: 'up' },
      }),
    ]);
    const client = createRenderFlowClient({ baseUrl: BASE_URL, fetchImpl: impl });

    await client.health.live();
    await client.health.ready();

    expect(calls[0]?.url).toBe('http://api.test/health/live');
    expect(calls[1]?.url).toBe('http://api.test/health/ready');
  });

  it('strips only the version segment from a custom prefix', async () => {
    const { impl, calls } = fakeFetch([
      jsonResponse({ status: 'ok', service: 'api', uptimeSeconds: 1 }),
      jsonResponse({ status: 'ok', checks: { database: 'up', redis: 'up', storage: 'up' } }),
    ]);
    const client = createRenderFlowClient({
      baseUrl: 'http://api.test/gateway/api/v1',
      fetchImpl: impl,
    });

    await client.health.live();

    expect(calls[0]?.url).toBe('http://api.test/gateway/health/live');
  });

  it('keeps versioned paths under the prefix', async () => {
    const { impl, calls } = fakeFetch([jsonResponse({})]);
    const client = createRenderFlowClient({ baseUrl: BASE_URL, fetchImpl: impl });

    await client.get('/me');

    expect(calls[0]?.url).toBe('http://api.test/api/v1/me');
  });
});
