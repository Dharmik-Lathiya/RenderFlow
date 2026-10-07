import {
  DEFAULT_SPECS,
  RATE_LIMIT_RULES,
  RateLimitConfigError,
  envKeyForRule,
  isDisabled,
  loadRateLimitConfig,
  parseRateLimitSpec,
  rateLimitSpecSchema,
  type RateLimitRuleName,
} from './rate-limit.config';

/**
 * Pure unit tests for the rate limit configuration.
 *
 * The store and the guard are covered in their own specs; what matters here is
 * that a malformed spec is rejected loudly and that no threshold is a literal
 * hidden in logic (AGENTS.md rule 12).
 */
describe('parseRateLimitSpec', () => {
  it('parses count/window for every supported unit', () => {
    expect(parseRateLimitSpec('10/15m')).toEqual({ limit: 10, windowMs: 15 * 60_000 });
    expect(parseRateLimitSpec('5/1h')).toEqual({ limit: 5, windowMs: 3_600_000 });
    expect(parseRateLimitSpec('100/30s')).toEqual({ limit: 100, windowMs: 30_000 });
    expect(parseRateLimitSpec('1/7d')).toEqual({ limit: 1, windowMs: 7 * 86_400_000 });
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseRateLimitSpec('  10/15m  ')).toEqual({ limit: 10, windowMs: 900_000 });
  });

  it('treats 0 as an explicit opt-out rather than an error', () => {
    // "Disabled" must be expressible in config, otherwise an operator who needs
    // to lift a limit during an incident has no supported way to do it.
    expect(parseRateLimitSpec('0')).toEqual({ limit: 0, windowMs: 0 });
    expect(parseRateLimitSpec('0/15m')).toEqual({ limit: 0, windowMs: 900_000 });
    expect(isDisabled(parseRateLimitSpec('0'))).toBe(true);
    expect(isDisabled(parseRateLimitSpec('1/1h'))).toBe(false);
  });

  it('rejects a spec it cannot understand instead of guessing', () => {
    // Silently defaulting a typo would leave an endpoint effectively unlimited,
    // which is the failure mode a rate limit exists to prevent.
    for (const bad of ['', 'abc', '10', '10/', '/15m', '10/15', '10/15minutes', '10/15x']) {
      expect(() => parseRateLimitSpec(bad)).toThrow(RateLimitConfigError);
    }
  });

  it('rejects a negative or fractional count', () => {
    expect(() => parseRateLimitSpec('-5/15m')).toThrow(RateLimitConfigError);
    expect(() => parseRateLimitSpec('10.5/15m')).toThrow(RateLimitConfigError);
  });

  it('rejects a zero-length window, which would expire instantly', () => {
    // `10/0m` would admit a request every time, i.e. no limit at all.
    expect(() => parseRateLimitSpec('10/0m')).toThrow(RateLimitConfigError);
  });

  it('names the offending value in the message', () => {
    expect(() => parseRateLimitSpec('nonsense')).toThrow(/"nonsense"/);
  });
});

describe('rateLimitSpecSchema', () => {
  it('accepts valid specs and rejects invalid ones', () => {
    expect(rateLimitSpecSchema.safeParse('10/15m').success).toBe(true);
    expect(rateLimitSpecSchema.safeParse('0').success).toBe(true);
    expect(rateLimitSpecSchema.safeParse('10/15minutes').success).toBe(false);
  });
});

describe('envKeyForRule', () => {
  it('derives the env var name mechanically', () => {
    expect(envKeyForRule(RATE_LIMIT_RULES.LOGIN_IP)).toBe('RATE_LIMIT_LOGIN_IP');
    expect(envKeyForRule(RATE_LIMIT_RULES.LOGIN_ACCOUNT)).toBe('RATE_LIMIT_LOGIN_ACCOUNT');
    expect(envKeyForRule(RATE_LIMIT_RULES.REGISTER_IP)).toBe('RATE_LIMIT_REGISTER_IP');
    expect(envKeyForRule(RATE_LIMIT_RULES.REFRESH_IP)).toBe('RATE_LIMIT_REFRESH_IP');
  });
});

describe('loadRateLimitConfig', () => {
  /** Minimal `ConfigService` stand-in. */
  const reader = (values: Record<string, unknown>) => ({
    get: <T>(key: string): T | undefined => values[key] as T | undefined,
  });

  it('falls back to the documented defaults', () => {
    const config = loadRateLimitConfig(reader({}));

    expect(config.enabled).toBe(true);
    expect(config.policies.LOGIN_IP).toEqual({ limit: 10, windowMs: 900_000 });
    expect(config.policies.LOGIN_ACCOUNT).toEqual({ limit: 30, windowMs: 3_600_000 });
    expect(config.policies.REGISTER_IP).toEqual({ limit: 5, windowMs: 3_600_000 });
    expect(config.policies.REFRESH_IP).toEqual({ limit: 60, windowMs: 900_000 });
  });

  it('overrides from configuration', () => {
    const config = loadRateLimitConfig(
      reader({ RATE_LIMIT_LOGIN_IP: '3/1m', RATE_LIMIT_REGISTER_IP: '0' }),
    );

    expect(config.policies.LOGIN_IP).toEqual({ limit: 3, windowMs: 60_000 });
    expect(config.policies.REGISTER_IP).toEqual({ limit: 0, windowMs: 0 });
    // Untouched rules keep their defaults rather than being zeroed.
    expect(config.policies.REFRESH_IP).toEqual({ limit: 60, windowMs: 900_000 });
  });

  it('reports every bad rule at once, naming the variable', () => {
    // One error per boot beats fixing them one restart at a time.
    let thrown: unknown;
    try {
      loadRateLimitConfig(
        reader({ RATE_LIMIT_LOGIN_IP: 'oops', RATE_LIMIT_REGISTER_IP: '5/nope' }),
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(RateLimitConfigError);
    const message = (thrown as Error).message;
    expect(message).toContain('RATE_LIMIT_LOGIN_IP');
    expect(message).toContain('RATE_LIMIT_REGISTER_IP');
  });

  it('reads the master switch in every documented spelling', () => {
    expect(loadRateLimitConfig(reader({ RATE_LIMIT_ENABLED: false })).enabled).toBe(false);
    expect(loadRateLimitConfig(reader({ RATE_LIMIT_ENABLED: 'false' })).enabled).toBe(false);
    expect(loadRateLimitConfig(reader({ RATE_LIMIT_ENABLED: 'off' })).enabled).toBe(false);
    expect(loadRateLimitConfig(reader({ RATE_LIMIT_ENABLED: '0' })).enabled).toBe(false);
    expect(loadRateLimitConfig(reader({ RATE_LIMIT_ENABLED: 'true' })).enabled).toBe(true);
  });

  it('defaults to enabled, and defaults an unrecognised switch to enabled', () => {
    // Failing open on the limiter is the right direction for availability: an
    // operator who mistypes the switch gets limits, not an unprotected endpoint.
    expect(loadRateLimitConfig(reader({})).enabled).toBe(true);
    expect(loadRateLimitConfig(reader({ RATE_LIMIT_ENABLED: 'maybe' })).enabled).toBe(true);
  });

  it('covers every declared rule', () => {
    const config = loadRateLimitConfig(reader({}));
    const names = Object.keys(RATE_LIMIT_RULES) as RateLimitRuleName[];

    for (const name of names) {
      expect(config.policies[name]).toBeDefined();
    }
    // Guards against a rule being added without a default, which would silently
    // leave that endpoint unlimited.
    expect(Object.keys(config.policies).sort()).toEqual([...names].sort());
  });

  it('ignores an empty string so a blanked variable falls back', () => {
    expect(loadRateLimitConfig(reader({ RATE_LIMIT_LOGIN_IP: '   ' })).policies.LOGIN_IP).toEqual(
      parseRateLimitSpec(DEFAULT_SPECS.LOGIN_IP),
    );
  });
});
