import { type INestApplication, RequestMethod } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import type { Response } from 'supertest';

import { getPrismaClient, resetPrismaClientForTests } from '@renderflow/db';

// `./env` applies the test environment as an import side effect and MUST stay
// above the AppModule import, which validates process.env at module scope.
import './env';
import { ACCESS_COOKIE, CSRF_COOKIE_NAME, REFRESH_COOKIE, TEST_ENV } from './env';
import {
  AllExceptionsFilter,
  configureExceptionLogger,
} from '../../../apps/api/src/common/all-exceptions.filter';
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
];

export interface TestApp {
  app: INestApplication;
  http: () => request.Agent;
  auth: AuthService;
  close: () => Promise<void>;
}

export async function createTestApp(env: NodeJS.ProcessEnv = TEST_ENV): Promise<TestApp> {
  Object.assign(process.env, env);

  // Keep the app's logging consistent with LOG_LEVEL after the harness has set
  // the rest of the environment.
  configureExceptionLogger(createLogger({ service: 'api', level: env.LOG_LEVEL ?? 'silent' }));
  configureAuthLogger(createLogger({ service: 'auth', level: env.LOG_LEVEL ?? 'silent' }));

  resetPrismaClientForTests();

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

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
    close: async () => {
      await app.close();
      await getPrismaClient().$disconnect();
      resetPrismaClientForTests();
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
