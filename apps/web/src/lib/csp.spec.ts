import { buildContentSecurityPolicy } from './csp';

describe('buildContentSecurityPolicy', () => {
  const base = {
    nonce: 'test-nonce',
    apiOrigin: 'https://api.renderflow.example',
  };

  it('uses a nonce and strict-dynamic instead of unsafe-inline for scripts', () => {
    const policy = buildContentSecurityPolicy({ ...base, isDev: false });

    expect(policy).toContain("script-src 'self' 'nonce-test-nonce' 'strict-dynamic'");
    expect(policy).not.toContain("script-src 'unsafe-inline'");
    expect(policy).not.toContain("script-src 'self' 'unsafe-inline'");
  });

  it('allows the API origin to be called from the browser', () => {
    const policy = buildContentSecurityPolicy({ ...base, isDev: false });

    expect(policy).toContain("connect-src 'self' https://api.renderflow.example https:");
  });

  it('adds unsafe-eval only in development', () => {
    const development = buildContentSecurityPolicy({ ...base, isDev: true });
    const production = buildContentSecurityPolicy({ ...base, isDev: false });

    expect(development).toContain("'unsafe-eval'");
    expect(production).not.toContain("'unsafe-eval'");
    expect(production).toContain('upgrade-insecure-requests');
  });

  it('locks down framing, objects and the base URI', () => {
    const policy = buildContentSecurityPolicy({ ...base, isDev: false });

    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("base-uri 'self'");
    expect(policy).toContain("form-action 'self'");
  });
});
