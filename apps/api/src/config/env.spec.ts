import { EnvValidationError, assertCorsIsExplicit, corsOrigins, envSchema, loadEnv } from './env';

/** Minimal valid environment; individual tests override one key at a time. */
const BASE: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://renderflow:renderflow@localhost:5432/renderflow_test',
  JWT_ACCESS_SECRET: 'a'.repeat(32),
  JWT_REFRESH_SECRET: 'b'.repeat(32),
};

describe('loadEnv', () => {
  it('accepts a minimal valid environment and applies defaults', () => {
    const env = loadEnv(BASE);

    expect(env.API_PORT).toBe(4000);
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.REDIS_URL).toBe('redis://localhost:6379');
    expect(env.JWT_ACCESS_TTL).toBe('15m');
    expect(env.SIGNUP_BONUS_CREDITS).toBe(50);
  });

  it('requires DATABASE_URL', () => {
    const { DATABASE_URL: _omitted, ...withoutDb } = BASE;
    expect(() => loadEnv(withoutDb)).toThrow(EnvValidationError);
  });

  it('requires both JWT secrets', () => {
    expect(() => loadEnv({ ...BASE, JWT_ACCESS_SECRET: '' })).toThrow(/JWT_ACCESS_SECRET/);
    expect(() => loadEnv({ ...BASE, JWT_REFRESH_SECRET: '' })).toThrow(/JWT_REFRESH_SECRET/);
  });

  it('rejects an unknown NODE_ENV', () => {
    expect(() => loadEnv({ ...BASE, NODE_ENV: 'staging' })).toThrow();
  });

  it('rejects a non-numeric or non-positive port', () => {
    expect(() => loadEnv({ ...BASE, API_PORT: 'abc' })).toThrow();
    expect(() => loadEnv({ ...BASE, API_PORT: '0' })).toThrow();
    expect(() => loadEnv({ ...BASE, API_PORT: '-1' })).toThrow();
  });

  it('coerces a numeric string port', () => {
    expect(loadEnv({ ...BASE, API_PORT: '8080' }).API_PORT).toBe(8080);
  });

  it('rejects a negative signup bonus', () => {
    expect(() => loadEnv({ ...BASE, SIGNUP_BONUS_CREDITS: '-1' })).toThrow();
    expect(() => loadEnv({ ...BASE, SIGNUP_BONUS_CREDITS: '1.5' })).toThrow();
  });

  it('rejects a WEB_BASE_URL that is not a URL', () => {
    expect(() => loadEnv({ ...BASE, WEB_BASE_URL: 'not a url' })).toThrow();
  });

  it('parses METRICS_ENABLED from a string flag', () => {
    expect(loadEnv({ ...BASE, METRICS_ENABLED: 'false' }).METRICS_ENABLED).toBe(false);
    expect(loadEnv({ ...BASE, METRICS_ENABLED: 'true' }).METRICS_ENABLED).toBe(true);
    expect(loadEnv(BASE).METRICS_ENABLED).toBe(true);
  });

  it('reports every invalid key at once rather than one per run', () => {
    let issues: string[] = [];
    try {
      loadEnv({ NODE_ENV: 'nope', API_PORT: 'x' });
    } catch (error) {
      issues = (error as EnvValidationError).issues;
    }
    expect(issues.length).toBeGreaterThan(1);
  });
});

describe('envSchema', () => {
  it('is exported so tests and tooling can validate without throwing', () => {
    expect(envSchema.safeParse(BASE).success).toBe(true);
  });
});

describe('corsOrigins', () => {
  it('splits and trims a comma-separated list', () => {
    const env = loadEnv({
      ...BASE,
      CORS_ORIGINS: 'http://localhost:3000, https://app.example.com',
    });
    expect(corsOrigins(env)).toEqual(['http://localhost:3000', 'https://app.example.com']);
  });

  it('drops empty entries', () => {
    const env = loadEnv({ ...BASE, CORS_ORIGINS: 'http://a.test, ,http://b.test,' });
    expect(corsOrigins(env)).toEqual(['http://a.test', 'http://b.test']);
  });

  it('returns a single origin unchanged', () => {
    expect(corsOrigins(loadEnv(BASE))).toEqual(['http://localhost:3000']);
  });
});

describe('assertCorsIsExplicit', () => {
  it('rejects a wildcard, which breaks credentialed cookie auth', () => {
    // Browsers reject `credentials: include` with `Access-Control-Allow-Origin: *`,
    // so a wildcard would look like "CORS is fine" while every request failed.
    const env = loadEnv({ ...BASE, CORS_ORIGINS: '*' });
    expect(() => assertCorsIsExplicit(env)).toThrow(EnvValidationError);
    expect(() => assertCorsIsExplicit(env)).toThrow(/explicit origins/);
  });

  it('accepts an explicit list, including alongside a wildcard entry', () => {
    const env = loadEnv({ ...BASE, CORS_ORIGINS: 'http://localhost:3000' });
    expect(() => assertCorsIsExplicit(env)).not.toThrow();
  });
});
