import { type INestApplication, RequestMethod } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import type { Response } from 'supertest';

import {
  RATE_LIMIT_CONFIG,
  RATE_LIMIT_STORE,
} from '../../../apps/api/src/ratelimit/rate-limit.guard';
import { loadRateLimitConfig } from '../../../apps/api/src/ratelimit/rate-limit.config';
import {
  InMemoryRateLimitStore,
  type RateLimitStore,
} from '../../../apps/api/src/ratelimit/rate-limit.store';
import { resetDbForTests } from '@renderflow/db';

// `./env` applies the test environment as an import side effect and MUST stay
// above the AppModule import, which validates process.env at module scope.
import './env';
import { ACCESS_COOKIE, CSRF_COOKIE_NAME, REFRESH_COOKIE, TEST_ENV } from './env';
import {
  AllExceptionsFilter,
  configureExceptionLogger,
} from '../../../apps/api/src/common/all-exceptions.filter';
import { OPENAPI_JSON_PATH } from '../../../apps/api/src/common/openapi';
import { AppModule } from '../../../apps/api/src/app.module';
import { AuthService, configureAuthLogger } from '../../../apps/api/src/auth/auth.service';
import { createLogger } from '@renderflow/observability';

/**
 * Boots the real Nest application against a real Postgres.
 *
 * No route is stubbed: the guards, the exception filter and the zod validation
 * are the production ones, so these tests exercise the HTTP surface a user
 * actually hits (PROJECT.md section 13.1, integration layer).
 */

const UNVERSIONED_ROUTES = [
  { path: 'health/live', method: RequestMethod.GET },
  { path: 'health/ready', method: RequestMethod.GET },
  { path: 'metrics', method: RequestMethod.GET },
  { path: OPENAPI_JSON_PATH, method: RequestMethod.GET },
];

export interface TestApp {
  app: INestApplication;
  http: () => request.Agent;
  auth: AuthService;
  /** The rate limit counters backing this app instance. */
  rateLimits: InMemoryRateLimitStore;
  close: () => Promise<void>;
}

export interface TestAppOptions {
  /**
   * Environment overrides for this instance, layered on top of `TEST_ENV`.
   *
   * Applied by overriding the `RATE_LIMIT_CONFIG` token, NOT by assigning
   * `process.env`. `ConfigModule.forRoot({ validate })` runs once when
   * `app.module.ts` is first imported and snapshots its result, so a later
   * `process.env` change - or an `overrideProvider(ConfigService)`, which does
   * not bind against the internal token `forRoot` registers - silently has no
   * effect. Overriding the module's own token is the seam that actually works.
   */
  env?: Record<string, string>;
  /**
   * Replaces the rate limit store. Each instance gets a fresh store regardless;
   * pass one explicitly only to reach into the counters.
   */
  rateLimitStore?: RateLimitStore;
}

export async function createTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const env = { ...TEST_ENV, ...options.env } as Record<string, string>;
  // Ambient env is still updated: `envSchema` validates `process.env` at import
  // time, so a missing key has to exist before AppModule is evaluated.
  Object.assign(process.env, env);

  // Keep the app's logging consistent with LOG_LEVEL after the harness has set
  // the rest of the environment.
  //
  // The exception filter's logger is pinned to 'error' when RENDERFLOW_TEST_LOGS
  // is set rather than following LOG_LEVEL ('silent'). A 500 that produces no
  // output at all is a 500 nobody can debug: silencing the only thing that
  // explains it is how a real bug hid here for an hour.
  const diagnosticLevel = process.env.RENDERFLOW_TEST_LOGS === '1' ? 'error' : 'silent';
  configureExceptionLogger(createLogger({ service: 'api', level: diagnosticLevel }));
  configureAuthLogger(createLogger({ service: 'auth', level: diagnosticLevel }));

  resetDbForTests();

  const rateLimits = new InMemoryRateLimitStore();

  const builder = Test.createTestingModule({ imports: [AppModule] });

  // Per-instance rate limit config, so `options.env` actually reaches the guard
  // instead of being frozen at AppModule's first import.
  if (options.env !== undefined) {
    builder
      .overrideProvider(RATE_LIMIT_CONFIG)
      .useValue(
        loadRateLimitConfig({ get: <T>(key: string): T | undefined => env[key] as T | undefined }),
      );
  }

  if (options.rateLimitStore !== undefined) {
    builder.overrideProvider(RATE_LIMIT_STORE).useValue(options.rateLimitStore);
  } else {
    // A fresh store per app: counters are per-instance state, and leaking them
    // between suites would make one suite's traffic change another's outcome.
    builder.overrideProvider(RATE_LIMIT_STORE).useValue(rateLimits);
  }
  const moduleRef = await builder.compile();

  const app = moduleRef.createNestApplication({ logger: false });
  // Resolve the HTTP server once. A fresh `request(app.getHttpServer())` per
  // call makes supertest attach new listeners to the same server on every
  // request; past ~10 calls Node emits MaxListenersExceededWarning, and with
  // enough suites the warnings themselves obscure real failures.
  const httpServer = app.getHttpServer();
  // Raise the limit rather than suppress it, so a genuine listener leak would
  // still surface at a much higher count.
  httpServer.setMaxListeners(0);
  app.setGlobalPrefix('api/v1', { exclude: UNVERSIONED_ROUTES });
  app.use(cookieParser());
  app.enableCors({ origin: ['http://localhost:3000'], credentials: true });
  app.useGlobalFilters(new AllExceptionsFilter());

  await app.init();

  const auth = app.get(AuthService);

  return {
    app,
    http: () => request(httpServer),
    auth,
    rateLimits: (options.rateLimitStore as InMemoryRateLimitStore | undefined) ?? rateLimits,
    close: async () => {
      await app.close();
      resetDbForTests();
    },
  };
}

/** Extracts a cookie value from a Set-Cookie header list. */
export function cookieFrom(res: Response, name: string): string | undefined {
  const cookies = res.headers['set-cookie'];
  const list = Array.isArray(cookies) ? cookies : cookies ? [cookies] : [];
  for (const cookie of list) {
    const [pair] = cookie.split(';');
    if (pair !== undefined && pair.trim().startsWith(`${name}=`)) {
      return pair.trim().slice(name.length + 1);
    }
  }
  return undefined;
}

/** Bearer token + CSRF header pair for authenticated requests. */
export function authHeaders(res: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  const access = cookieFrom(res, 'rf_access');
  if (access !== undefined) {
    headers.Cookie = `rf_access=${access}`;
  }
  const csrf = cookieFrom(res, 'rf_csrf');
  if (csrf !== undefined) {
    headers['x-csrf-token'] = csrf;
  }
  return headers;
}

/**
 * Cookie pairs used by the auth routes.
 *
 * The CSRF guard needs BOTH the `rf_csrf` cookie and a matching header, so a
 * request carrying only the refresh cookie is rejected 403 before the refresh
 * token is even examined. `sessionCookies` sends both from the same response
 * that established the session.
 */
export function sessionCookies(res: Response): string {
  const parts: string[] = [];
  for (const name of [ACCESS_COOKIE, REFRESH_COOKIE, CSRF_COOKIE_NAME]) {
    const value = cookieFrom(res, name);
    if (value !== undefined) {
      parts.push(`${name}=${value}`);
    }
  }
  return parts.join('; ');
}

/** The CSRF value from a session-establishing response. */
export function csrfOf(res: Response): string {
  const value = cookieFrom(res, CSRF_COOKIE_NAME);
  if (value === undefined) {
    throw new Error('response carried no CSRF cookie');
  }
  return value;
}
