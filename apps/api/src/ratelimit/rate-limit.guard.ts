import {
  Inject,
  Injectable,
  SetMetadata,
  type CanActivate,
  type CustomDecorator,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppError, ERROR_CODES } from '@renderflow/common';
import type { Response } from 'express';

import { clientIp, type RequestWithAuth } from '../auth/request.types';
import {
  RATE_LIMIT_RULES,
  isDisabled,
  type RateLimitConfig,
  type RateLimitRuleName,
} from './rate-limit.config';
import type { RateLimitDecision, RateLimitStore } from './rate-limit.store';

/**
 * Which part of the request identifies the caller for a rule.
 *
 * `ip`   - source address. The right default for unauthenticated endpoints.
 * `user` - the authenticated user id, falling back to the IP. This is the
 *          "per-user API limits" PROJECT.md section 14 asks for; it becomes
 *          meaningful once generation endpoints exist.
 * `email`- the submitted email address, normalised. Only meaningful on a route
 *          whose body carries one.
 */
export type RateLimitScope = 'ip' | 'user' | 'email';

export interface RateLimitRuleRef {
  name: RateLimitRuleName;
  scope: RateLimitScope;
}

/**
 * Resolved configuration, injected rather than read per request.
 *
 * A dedicated token rather than `ConfigService` for two reasons: parsing config
 * on every request is wasted work, and - more importantly for correctness - the
 * token is what tests override. `ConfigModule.forRoot` registers its own service
 * under an internal provider, so overriding `ConfigService` from a testing module
 * silently does nothing; a token owned by this module actually binds.
 */
export const RATE_LIMIT_CONFIG = Symbol('RATE_LIMIT_CONFIG');
export const RATE_LIMIT_STORE = Symbol('RATE_LIMIT_STORE');

/**
 * Applies one or more limits to a route.
 *
 * Routes without this decorator are unlimited, which mirrors the existing
 * `@Public()` model: the guard is global, and the exemption is explicit at the
 * call site, so adding a new endpoint cannot accidentally inherit someone's
 * limit (or lack one) by proximity.
 */
export const RATE_LIMIT_KEY = 'renderflow:rateLimits';

export const RateLimit = (...rules: RateLimitRuleRef[]): CustomDecorator =>
  SetMetadata(RATE_LIMIT_KEY, rules);

/** Short helpers so the controller reads declaratively. */
export const RateLimitByIp = (name: RateLimitRuleName): CustomDecorator =>
  RateLimit({ name, scope: 'ip' });

export const RateLimitByUser = (name: RateLimitRuleName): CustomDecorator =>
  RateLimit({ name, scope: 'user' });

/** Raised when a caller exceeds a limit. The filter turns this into a 429. */
export class RateLimitedError extends AppError {
  constructor(
    readonly rule: RateLimitRuleName,
    decision: RateLimitDecision,
  ) {
    super(ERROR_CODES.RATE_LIMITED, undefined, {
      details: {
        rule,
        limit: decision.limit,
        retryAfterSeconds: decision.retryAfterSeconds,
      },
    });
  }
}

/**
 * Global rate limit guard.
 *
 * Registered FIRST in the guard chain, before CSRF and authentication, because
 * the expensive work it protects is argon2 - roughly 50ms of CPU per login - and
 * that has already happened by the time any handler runs. The only way to make
 * an unauthenticated credential endpoint safe is to reject before the hash.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(RATE_LIMIT_CONFIG) private readonly config: RateLimitConfig,
    @Inject(RATE_LIMIT_STORE) private readonly store: RateLimitStore,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const rules = this.reflector.getAllAndOverride<RateLimitRuleRef[]>(RATE_LIMIT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (rules === undefined || rules.length === 0 || !this.config.enabled) {
      return true;
    }

    const request = context.switchToHttp().getRequest<RequestWithAuth>();
    const response = context.switchToHttp().getResponse<Response>();
    const now = Date.now();

    const decisions: Array<{ name: RateLimitRuleName; decision: RateLimitDecision }> = [];

    for (const rule of rules) {
      const policy = this.config.policies[rule.name];
      if (policy === undefined || isDisabled(policy)) {
        continue;
      }

      const key = `${rule.name}:${this.identityFor(rule.scope, request)}`;
      const decision = this.store.hit(key, policy, now);
      decisions.push({ name: rule.name, decision });

      if (!decision.allowed) {
        // The reject happens here, before the controller, so the hash never runs.
        // Headers describe the rule that refused, so `Retry-After` is accurate.
        setRateLimitHeaders(response, decision);
        throw new RateLimitedError(rule.name, decision);
      }
    }

    if (decisions.length > 0) {
      // A route may carry several rules (login has an IP and an account limit).
      // Reporting only the last one would describe a budget the client has
      // plenty of while the tighter one is the one about to refuse them, so the
      // most constrained rule is the one advertised.
      setRateLimitHeaders(response, tightestDecision(decisions.map((entry) => entry.decision)));
    }

    return true;
  }

  /**
   * Derives the counter key for a scope.
   *
   * The email is untrusted request input read before zod has validated the body,
   * so it is only ever used as an opaque bucket name: lowercased, trimmed and
   * length-capped. It is never logged or echoed. Trimming and case-folding
   * matter beyond hygiene - without them an attacker could evade the
   * per-account limit with `victim@x.com`, `Victim@X.com ` and so on, which
   * would leave the control protecting nothing.
   */
  private identityFor(scope: RateLimitScope, request: RequestWithAuth): string {
    const ip = clientIp(request) ?? 'unknown';

    switch (scope) {
      case 'user':
        return request.user?.id ?? ip;
      case 'email': {
        const email = emailFromBody(request.body);
        // Falling back to the IP when no email was submitted keeps the key
        // finite: an attacker sending garbage bodies cannot mint unbounded keys.
        return email ?? ip;
      }
      case 'ip':
        return ip;
      default: {
        const exhaustive: never = scope;
        throw new Error(`Unhandled rate limit scope: ${String(exhaustive)}`);
      }
    }
  }
}

/**
 * Picks the rule a client should plan around.
 *
 * "Tightest" is compared as the *fraction* of budget left, not the raw count,
 * because the budgets differ by orders of magnitude: a limit of 2/15m with 1
 * left is tighter than 30/1h with 29 left, but the raw counts say the opposite.
 */
export function tightestDecision(decisions: RateLimitDecision[]): RateLimitDecision {
  return decisions.reduce((tightest, current) => {
    if (current.limit <= 0) {
      return tightest;
    }
    if (tightest.limit <= 0) {
      return current;
    }
    const tightestLeft = tightest.remaining / tightest.limit;
    const currentLeft = current.remaining / current.limit;
    return currentLeft < tightestLeft ? current : tightest;
  });
}

/**
 * IETF draft rate limit headers, so a client can back off without parsing prose.
 *
 * `RateLimit-Reset` is seconds until the window resets (not a timestamp), which
 * is what the draft specifies.
 */
export function setRateLimitHeaders(response: Response, decision: RateLimitDecision): void {
  const remainingSeconds = Math.max(0, Math.ceil((decision.resetAt - Date.now()) / 1000));

  response.setHeader('RateLimit-Limit', String(decision.limit));
  response.setHeader('RateLimit-Remaining', String(decision.remaining));
  response.setHeader('RateLimit-Reset', String(remainingSeconds));

  if (!decision.allowed) {
    response.setHeader('Retry-After', String(decision.retryAfterSeconds));
  }
}

const MAX_EMAIL_KEY_LENGTH = 320; // RFC 5321 maximum path length.

function emailFromBody(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) {
    return undefined;
  }
  const raw = (body as { email?: unknown }).email;
  if (typeof raw !== 'string') {
    return undefined;
  }
  const normalised = raw.trim().toLowerCase();
  return normalised === '' ? undefined : normalised.slice(0, MAX_EMAIL_KEY_LENGTH);
}

export { RATE_LIMIT_RULES };
