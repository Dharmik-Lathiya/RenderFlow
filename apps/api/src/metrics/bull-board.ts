import type { INestApplication } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import type { Queue } from 'bullmq';

import { ALL_QUEUE_NAMES } from '@renderflow/common';
import { createQueue, loadQueueConfig } from '@renderflow/queue';

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

export async function mountBullBoard(
  app: INestApplication,
  authConfig: AuthConfig,
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

  app.use(basePath, adminOnly(authConfig), serverAdapter.getRouter());

  return {
    close: async () => {
      await Promise.all(queues.map((queue) => queue.close()));
    },
  };
}

/**
 * The guard the Nest pipeline cannot apply to this router.
 *
 * Asynchronous because a future version may need to check the role against the
 * database; today the role is in the signed token, and a token that says ADMIN
 * is a token the server issued to an admin.
 */
export function adminOnly(authConfig: AuthConfig) {
  return (request: Request, response: Response, next: NextFunction): void => {
    const token = extractToken(request);

    if (token === null) {
      response.status(401).json({ code: 'UNAUTHORIZED', message: 'Authentication required' });
      return;
    }

    try {
      const claims = verifyAccessToken(token, authConfig.JWT_ACCESS_SECRET);

      if (claims.role !== 'ADMIN') {
        response.status(403).json({ code: 'FORBIDDEN', message: 'Global ADMIN role required' });
        return;
      }

      next();
    } catch {
      // The verifier's message is deliberately not echoed: it distinguishes an
      // expired token from a forged one, and that is a hint an attacker does not
      // need.
      response.status(401).json({ code: 'UNAUTHORIZED', message: 'Invalid access token' });
    }
  };
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
