import { z } from 'zod';

/**
 * Rate limit configuration (PROJECT.md section 14 item 10, section 15:
 * "Rate limit auth and generation endpoints"; AGENTS.md section 10).
 *
 * Every threshold is configuration. Nothing here is a literal in logic
 * (AGENTS.md rule 12), so an environment can tighten or loosen a limit without a
 * code change, and the defaults live in exactly one place: `DEFAULT_SPECS`.
 */

export const RATE_LIMIT_RULES = {
  /** Per client IP. Stops the expensive-credential path (argon2) being flooded. */
  LOGIN_IP: 'LOGIN_IP',
  /**
   * Per submitted email. Per-IP alone cannot stop a *distributed* credential
   * stuffing run aimed at one account.
   *
   * Deliberately generous: a tighter limit turns this into a denial-of-service
   * tool against any address the attacker knows. See `docs` note below.
   */
  LOGIN_ACCOUNT: 'LOGIN_ACCOUNT',
  /** Per client IP. Each registration writes a user and grants a bonus. */
  REGISTER_IP: 'REGISTER_IP',
  /** Per client IP. Cheap, but bounded so it cannot be used to exhaust the pool. */
  REFRESH_IP: 'REFRESH_IP',
} as const;

export type RateLimitRuleName = (typeof RATE_LIMIT_RULES)[keyof typeof RATE_LIMIT_RULES];

/** A resolved limit. `limit: 0` means the rule is switched off. */
export interface RateLimitPolicy {
  limit: number;
  windowMs: number;
}

export interface RateLimitConfig {
  /** Master switch. Off in load tests; every rule is bypassed when false. */
  enabled: boolean;
  policies: Readonly<Record<RateLimitRuleName, RateLimitPolicy>>;
}

const WINDOW_UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

/**
 * Defaults.
 *
 * Shapes taken from common public guidance for credential endpoints rather than
 * invented: a burst of logins is normal (someone retyping), a burst of
 * registrations is not (each one mints a user *and* credits), so registration is
 * the tighter of the two.
 */
const DEFAULT_SPECS = {
  LOGIN_IP: '10/15m',
  LOGIN_ACCOUNT: '30/1h',
  REGISTER_IP: '5/1h',
  REFRESH_IP: '60/15m',
} as const satisfies Readonly<Record<RateLimitRuleName, string>>;

/**
 * `count/window`, e.g. `10/15m`. A bare `0` disables the rule.
 *
 * Parsed rather than assembled from two env vars so a half-configured limit
 * (`RATE_LIMIT_LOGIN_LIMIT=10` with no window) is a boot failure instead of an
 * endpoint that is accidentally unlimited or accidentally instant.
 */
export function parseRateLimitSpec(spec: string): RateLimitPolicy {
  const trimmed = spec.trim();

  if (/^0+$/.test(trimmed)) {
    return { limit: 0, windowMs: 0 };
  }

  const match = /^(\d+)\/(\d+)([smhd])$/.exec(trimmed);
  if (match === null) {
    throw new RateLimitConfigError([
      `Unparseable rate limit "${spec}"; expected "<count>/<window>", e.g. "10/15m", or "0" to disable`,
    ]);
  }

  const count = Number(match[1]);
  const duration = Number(match[2]);
  const unit = match[3] as keyof typeof WINDOW_UNIT_MS;

  if (!Number.isSafeInteger(count) || count < 0) {
    throw new RateLimitConfigError([
      `Rate limit count must be a non-negative integer in "${spec}"`,
    ]);
  }
  if (!Number.isSafeInteger(duration) || duration <= 0) {
    throw new RateLimitConfigError([`Rate limit window must be positive in "${spec}"`]);
  }

  return { limit: count, windowMs: duration * WINDOW_UNIT_MS[unit] };
}

export class RateLimitConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid rate limit configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'RateLimitConfigError';
  }
}

/** `LOGIN_IP` -> `RATE_LIMIT_LOGIN_IP`. Keeps env naming mechanical. */
export function envKeyForRule(rule: RateLimitRuleName): string {
  return `RATE_LIMIT_${rule}`;
}

/**
 * zod schema for one spec, used by `envSchema` so a malformed value fails at
 * boot with the variable name attached rather than at the first request.
 */
export const rateLimitSpecSchema = z.string().refine(
  (value) => {
    try {
      parseRateLimitSpec(value);
      return true;
    } catch {
      return false;
    }
  },
  { message: 'expected "<count>/<window>" such as "10/15m", or "0" to disable' },
);

/** Minimal view of `ConfigService`, mirroring `auth.config.ts`. */
export interface RateLimitConfigReader {
  get<T>(key: string): T | undefined;
}

/**
 * Reads the limit set.
 *
 * Like `loadAuthConfigFrom`, values are extracted by key first: a
 * `ConfigService` is not an env-shaped record, so validating the instance
 * directly silently yields `undefined` for everything.
 */
export function loadRateLimitConfig(reader: RateLimitConfigReader): RateLimitConfig {
  const issues: string[] = [];

  const policies = {} as Record<RateLimitRuleName, RateLimitPolicy>;

  for (const rule of Object.keys(RATE_LIMIT_RULES) as RateLimitRuleName[]) {
    const key = envKeyForRule(rule);
    const raw = reader.get<unknown>(key);
    const spec = typeof raw === 'string' && raw.trim() !== '' ? raw : DEFAULT_SPECS[rule];

    try {
      policies[rule] = parseRateLimitSpec(spec);
    } catch (error) {
      issues.push(`${key}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (issues.length > 0) {
    throw new RateLimitConfigError(issues);
  }

  return { enabled: readEnabled(reader.get<unknown>('RATE_LIMIT_ENABLED')), policies };
}

/**
 * Reads the master switch.
 *
 * `envSchema` already normalises this to a real boolean, so the string branches
 * only matter for a `ConfigService` populated some other way. They deliberately
 * do not report an error: a misspelt switch should mean "limits on", never a
 * boot failure on an endpoint whose purpose is availability.
 */
function readEnabled(raw: unknown): boolean {
  if (typeof raw === 'boolean') {
    return raw;
  }
  if (typeof raw === 'string') {
    return !['false', '0', 'no', 'off'].includes(raw.trim().toLowerCase());
  }
  return true;
}

/** A limit of zero means the rule is deliberately switched off. */
export function isDisabled(policy: RateLimitPolicy): boolean {
  return policy.limit <= 0;
}

export { DEFAULT_SPECS };
