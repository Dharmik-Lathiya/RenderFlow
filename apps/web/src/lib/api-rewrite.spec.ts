import {
  apiRewriteDestination,
  apiUpstreamOrigin,
  apiUpstreamUrl,
  type ApiRewriteEnv,
} from './api-rewrite';

const LOCAL = 'http://localhost:4000/api/v1';
const RENDER = 'https://renderflow-api.onrender.com/api/v1';

describe('apiUpstreamUrl', () => {
  it('uses localhost outside production when nothing is configured', () => {
    expect(apiUpstreamUrl({})).toBe(LOCAL);
  });

  it('uses the Render API in production when nothing is configured', () => {
    expect(apiUpstreamUrl({ NODE_ENV: 'production' })).toBe(RENDER);
  });

  it('prefers an absolute API_INTERNAL_URL and trims trailing slashes', () => {
    expect(
      apiUpstreamUrl({
        NODE_ENV: 'production',
        API_INTERNAL_URL: 'https://internal.example.com/api/v1///',
      }),
    ).toBe('https://internal.example.com/api/v1');
  });

  it('never uses a relative NEXT_PUBLIC_API_URL as the upstream', () => {
    // This is the Vercel misconfiguration that produced a /_not-found 404.
    expect(apiUpstreamUrl({ NEXT_PUBLIC_API_URL: '/api/v1' })).toBe(LOCAL);
    expect(apiUpstreamUrl({ NODE_ENV: 'production', NEXT_PUBLIC_API_URL: '/api/v1' })).toBe(RENDER);
  });

  it('ignores relative or non-HTTP API_INTERNAL_URL values', () => {
    expect(apiUpstreamUrl({ API_INTERNAL_URL: '/api/v1' })).toBe(LOCAL);
    expect(apiUpstreamUrl({ API_INTERNAL_URL: 'ftp://api.example.com' })).toBe(LOCAL);
  });

  it('accepts an absolute NEXT_PUBLIC_API_URL for older deployments', () => {
    const env: ApiRewriteEnv = { NEXT_PUBLIC_API_URL: 'https://api.example.com/api/v1' };
    expect(apiUpstreamUrl(env)).toBe('https://api.example.com/api/v1');
  });
});

describe('apiRewriteDestination', () => {
  it('always produces an absolute external destination', () => {
    expect(apiRewriteDestination({})).toBe(`${LOCAL}/:path*`);
    expect(apiRewriteDestination({ NODE_ENV: 'production' })).toBe(`${RENDER}/:path*`);
    expect(apiRewriteDestination({ API_INTERNAL_URL: '/api/v1' })).toBe(`${LOCAL}/:path*`);
  });
});

describe('apiUpstreamOrigin', () => {
  it('returns the connection origin without the /api/v1 path', () => {
    expect(apiUpstreamOrigin({ NODE_ENV: 'production' })).toBe(
      'https://renderflow-api.onrender.com',
    );
  });
});
