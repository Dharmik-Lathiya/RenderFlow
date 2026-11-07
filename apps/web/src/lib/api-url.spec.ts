/**
 * The API base URL must never fall back to a hardcoded host.
 *
 * The default used to be `http://localhost:4000/api/v1`, which sent production
 * visitors' browsers to their own computers. These tests pin the safe
 * default: a same-origin relative path, proxied by the rewrite in
 * `next.config.ts`.
 */
describe('api-url', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it('defaults to the same-origin relative path, never a localhost host', async () => {
    delete process.env.NEXT_PUBLIC_API_URL;

    const { API_BASE_URL, API_IS_CROSS_ORIGIN, eventStreamUrl } = await import('./api-url');

    expect(API_BASE_URL).toBe('/api/v1');
    expect(API_BASE_URL).not.toContain('localhost');
    expect(API_IS_CROSS_ORIGIN).toBe(false);
    expect(eventStreamUrl('/jobs/42/stream')).toBe('/api/v1/jobs/42/stream');
  });

  it('honours an explicitly configured absolute API URL', async () => {
    process.env.NEXT_PUBLIC_API_URL = 'https://api.example.com/api/v1/';

    const { API_BASE_URL, eventStreamUrl } = await import('./api-url');

    expect(API_BASE_URL).toBe('https://api.example.com/api/v1');
    expect(eventStreamUrl('/jobs/42/stream')).toBe('https://api.example.com/api/v1/jobs/42/stream');

    delete process.env.NEXT_PUBLIC_API_URL;
  });
});
