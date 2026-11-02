import type { INestApplication } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import type { Queue } from 'bullmq';

import { ALL_QUEUE_NAMES } from '@renderflow/common';
import { createQueue, loadQueueConfig } from '@renderflow/queue';
import { createLogger } from '@renderflow/observability';

import { ACCESS_TOKEN_COOKIE, type AuthConfig } from '../auth/auth.config';
import { verifyAccessToken } from '../auth/token.service';

/**
 * Bull Board (PROJECT.md section 12 Phase 9).
 *
 * Mounted as Express middleware rather than as a Nest controller, because the
 * board ships its own router. That has one consequence worth being explicit
 * about: **Nest's global guards do not run for it**. The default-deny AuthGuard
 * protects controllers; an `app.use()` route would bypass it entirely, and an
 * unprotected Bull Board is a cross-tenant data leak with a nice UI.
 *
 * So the middleware below performs the same check the guard would:
 *
 *  - a valid access token from the httpOnly cookie or a Bearer header;
 *  - the global `ADMIN` role, not a workspace OWNER. The board shows every
 *    workspace's job payloads, and an owner must not see another tenant's.
 *
 * The role comes from the signed token, and `verifyAccessToken` is the same
 * function the guard uses, so there is one definition of "authenticated".
 */

export interface BullBoardMount {
  close: () => Promise<void>;
}

/**
 * What the board records for each operator visit.
 *
 * Deliberately not the query string or any payload: a path is enough to say
 * "this admin opened the queue board", and job payloads may contain brand text
 * that AGENTS.md forbids logging.
 */
export interface BullBoardAccess {
  actorId: string;
  role: string;
  method: string;
  path: string;
  ip?: string;
}

export interface BullBoardAudit {
  /** Resolves once the access is durable. Rejecting denies the request. */
  record(access: BullBoardAccess): Promise<void>;
}

export async function mountBullBoard(
  app: INestApplication,
  authConfig: AuthConfig,
  audit: BullBoardAudit,
  basePath = '/api/v1/admin/queues',
): Promise<BullBoardMount> {
  // Imported lazily: these are CJS packages with a UI bundle, and loading them at
  // module scope would pay for it in every test that boots the API. `import()`
  // rather than `require()` so the module graph stays statically analysable and
  // the source does not smuggle a CommonJS call past the lint rule.
  const [{ createBullBoard }, { BullMQAdapter }, { ExpressAdapter }] = await Promise.all([
    import('@bull-board/api'),
    import('@bull-board/api/bullMQAdapter'),
    import('@bull-board/express'),
  ]);

  const queueConfig = loadQueueConfig();

  const queues: Queue[] = ALL_QUEUE_NAMES.map((name) =>
    createQueue(name, queueConfig.presets[name], {
      redisUrl: queueConfig.redisUrl,
      prefix: queueConfig.prefix,
    }),
  );

  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath(basePath);

  createBullBoard({
    queues: queues.map((queue) => new BullMQAdapter(queue)),
    serverAdapter,
  });

  app.use(basePath, adminOnly(authConfig, audit), serverAdapter.getRouter());

  return {
    close: async () => {
      await Promise.all(queues.map((queue) => queue.close()));
    },
  };
}

/**
 * The guard the Nest pipeline cannot apply to this router.
 *
 * Asynchronous because the audit write must complete before the board is
 * served: an access that cannot be recorded is refused. The token check itself
 * needs no database - `verifyAccessToken` is the same function the Nest guard
 * uses, so there is one definition of "authenticated".
 *
 * Static assets are not audited. They contain no tenant data, and a single board
 * page loads several of them; writing a row per asset would bury the actual
 * visits in noise.
 */
export function adminOnly(authConfig: AuthConfig, audit?: BullBoardAudit) {
  return async (request: Request, response: Response, next: NextFunction): Promise<void> => {
    const token = extractToken(request);

    if (token === null) {
      response.status(401).json({ code: 'UNAUTHORIZED', message: 'Authentication required' });
      return;
    }

    let claims: ReturnType<typeof verifyAccessToken>;
    try {
      claims = verifyAccessToken(token, authConfig.JWT_ACCESS_SECRET);
    } catch {
      // The verifier's message is deliberately not echoed: it distinguishes an
      // expired token from a forged one, and that is a hint an attacker does not
      // need.
      response.status(401).json({ code: 'UNAUTHORIZED', message: 'Invalid access token' });
      return;
    }

    if (claims.role !== 'ADMIN') {
      response.status(403).json({ code: 'FORBIDDEN', message: 'Global ADMIN role required' });
      return;
    }

    if (audit !== undefined && !isStaticAsset(request.path)) {
      try {
        await audit.record({
          actorId: claims.sub,
          role: claims.role,
          method: request.method,
          path: truncatePath(request.path),
          ...(request.ip === undefined ? {} : { ip: request.ip }),
        });
      } catch {
        // Fail closed: the board exposes every tenant's job payloads, and an
        // unauditable visit is exactly what this control exists to prevent.
        // Operators still have `redis-cli` and the DLQ endpoints during an
        // incident.
        log().error(
          { event: 'BULL_BOARD_AUDIT_FAILED', actorId: claims.sub },
          'refusing queue board access because the audit write failed',
        );
        response.status(503).json({
          code: 'SERVICE_UNAVAILABLE',
          message: 'Queue board access could not be audited',
        });
        return;
      }
    }

    next();
  };
}

/** Bull Board serves its UI bundle below `/static/`; those requests carry no data. */
function isStaticAsset(path: string): boolean {
  return path.startsWith('/static/') || path === '/favicon.ico';
}

/** `audit_logs.entity_id` is 64 characters; a path is bounded, not trusted. */
function truncatePath(path: string): string {
  return path.slice(0, 64);
}

let logger: ReturnType<typeof createLogger> | null = null;

function log(): ReturnType<typeof createLogger> {
  const level = process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'test' ? 'silent' : 'info');
  logger ??= createLogger({ service: 'bull-board', level });
  return logger;
}

function extractToken(request: Request): string | null {
  const header = request.headers.authorization;

  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    return header.slice('Bearer '.length).trim();
  }

  // `express` types `cookies` as `any` because cookie-parser augments it at
  // runtime; narrowing here keeps the rest of the check type-safe.
  const cookies = request.cookies as Record<string, unknown> | undefined;
  const cookie = cookies?.[ACCESS_TOKEN_COOKIE];
  return typeof cookie === 'string' && cookie !== '' ? cookie : null;
}
