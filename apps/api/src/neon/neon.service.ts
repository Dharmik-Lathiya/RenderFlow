import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppError, ERROR_CODES } from '@renderflow/common';
import {
  getDb,
  generationJobs,
  jobCheckpoints,
  posts,
  brands,
  workspaceMembers,
} from '@renderflow/db';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import type { Env } from '../config/env';

/**
 * Native ESM import for the Neon SDKs.
 *
 * The API is compiled to CommonJS, while `@neon/realtime` and `jose` publish
 * ESM-only entry points. TypeScript would rewrite a normal `import()` to
 * `require()`, which throws at runtime; routing through `Function` keeps the
 * native dynamic import without changing the whole monorepo's module target.
 */
// eslint-disable-next-line @typescript-eslint/no-implied-eval -- native import() is required because TS rewrites it to require() under CommonJS; these SDKs are ESM-only.
const importEsm = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const jwksSchema = z.object({ keys: z.array(z.object({ kid: z.string().optional() })) });
const modelsSchema = z.object({
  data: z.array(z.object({ id: z.string() })).default([]),
});

interface JoseModule {
  createRemoteJWKSet: (url: URL) => unknown;
  jwtVerify: (
    token: string,
    key: unknown,
    options: { algorithms: string[]; issuer: string; audience: string },
  ) => Promise<{ payload: { sub?: string; email?: unknown } }>;
}

interface SealedLiveQuery {
  capability: string;
  expiresAt: number;
  queryFingerprint: string;
}

interface RealtimeServer {
  seal: (input: { query: unknown }) => Promise<SealedLiveQuery>;
}

interface RealtimeModule {
  createRealtime: (options: { secret: string; db: string; adapter: unknown }) => RealtimeServer;
}

interface RealtimeDrizzleModule {
  drizzleAdapter: () => unknown;
}

export interface NeonStatus {
  branch: string | null;
  postgres: { pooled: boolean; direct: boolean };
  auth: { configured: boolean; jwksReachable: boolean; keyCount: number };
  aiGateway: { configured: boolean; model: string; modelCount: number | null };
  functions: { configured: boolean; helloUrl: string | null };
  realtime: { configured: boolean; url: string | null; sealedQueriesIssued: number };
}

export interface NeonAuthIdentity {
  subject: string;
  email: string | null;
}

/**
 * Thin adapter around the Neon services provisioned by `neon.ts`.
 *
 * Deliberately additive: RenderFlow's own cookie/JWT auth stays in charge of the
 * web app, per the Neon Auth skill. Neon Auth is exposed here as an optional
 * identity source for service-to-service callers, and Neon Realtime only seals
 * queries after the app's normal workspace membership check passes.
 */
@Injectable()
export class NeonService {
  private sealedQueriesIssued = 0;

  constructor(private readonly config: ConfigService<Env, true>) {}

  private get(env: keyof Env): string | undefined {
    const value = this.config.get(env, { infer: true });
    return typeof value === 'string' && value !== '' ? value : undefined;
  }

  private require(env: keyof Env, label: string): string {
    const value = this.get(env);
    if (value === undefined) {
      throw new AppError(ERROR_CODES.SERVICE_UNAVAILABLE, undefined, {
        details: { service: 'neon', missing: label },
      });
    }
    return value;
  }

  async status(): Promise<NeonStatus> {
    const auth = await this.authProbe();
    const gateway = await this.gatewayProbe();
    const helloUrl = this.functionUrl();

    return {
      branch: this.get('NEON_BRANCH') ?? null,
      postgres: {
        pooled: this.get('DATABASE_URL') !== undefined,
        direct: this.get('DATABASE_URL_UNPOOLED') !== undefined,
      },
      auth: {
        configured: this.get('NEON_AUTH_JWKS_URL') !== undefined,
        jwksReachable: auth.reachable,
        keyCount: auth.keyCount,
      },
      aiGateway: {
        configured: this.get('NEON_AI_GATEWAY_TOKEN') !== undefined,
        model: this.get('NEON_AI_GATEWAY_MODEL') ?? 'gpt-5-mini',
        modelCount: gateway.modelCount,
      },
      functions: {
        configured: this.get('NEON_FUNCTION_HOST_SUFFIX') !== undefined && helloUrl !== null,
        helloUrl,
      },
      realtime: {
        configured:
          this.get('NEON_REALTIME_SECRET') !== undefined &&
          this.get('NEON_REALTIME_URL') !== undefined,
        url: this.get('NEON_REALTIME_URL') ?? null,
        sealedQueriesIssued: this.sealedQueriesIssued,
      },
    };
  }

  /** Proves the managed Auth JWKS endpoint is reachable and returns usable keys. */
  async authProbe(): Promise<{ reachable: boolean; keyCount: number; issuer: string | null }> {
    const jwksUrl = this.get('NEON_AUTH_JWKS_URL');
    const baseUrl = this.get('NEON_AUTH_BASE_URL');
    const issuer = baseUrl === undefined ? null : new URL(baseUrl).origin;

    if (jwksUrl === undefined) {
      return { reachable: false, keyCount: 0, issuer };
    }

    try {
      const response = await fetch(jwksUrl, { signal: AbortSignal.timeout(5_000) });
      if (!response.ok) {
        return { reachable: false, keyCount: 0, issuer };
      }
      const parsed = jwksSchema.safeParse(await response.json());
      return {
        reachable: parsed.success,
        keyCount: parsed.success ? parsed.data.keys.length : 0,
        issuer,
      };
    } catch {
      return { reachable: false, keyCount: 0, issuer };
    }
  }

  /** Verifies a Managed Better Auth JWT without changing RenderFlow's own login. */
  async verifyAuthToken(token: string): Promise<NeonAuthIdentity> {
    const jwksUrl = this.require('NEON_AUTH_JWKS_URL', 'NEON_AUTH_JWKS_URL');
    const baseUrl = this.require('NEON_AUTH_BASE_URL', 'NEON_AUTH_BASE_URL');
    const origin = new URL(baseUrl).origin;

    const mod = (await importEsm('jose')) as unknown as JoseModule;
    const jwks = mod.createRemoteJWKSet(new URL(jwksUrl));
    const { payload } = await mod.jwtVerify(token, jwks, {
      algorithms: ['EdDSA'],
      issuer: origin,
      audience: origin,
    });

    if (payload.sub === undefined || payload.sub === '') {
      throw new AppError(ERROR_CODES.UNAUTHORIZED, 'Neon Auth token has no subject');
    }

    return {
      subject: payload.sub,
      email: typeof payload.email === 'string' ? payload.email : null,
    };
  }

  /** Lists models through the OpenAI-compatible gateway; no inference credits needed. */
  async gatewayProbe(): Promise<{ ok: boolean; modelCount: number | null; error?: string }> {
    const token = this.get('NEON_AI_GATEWAY_TOKEN');
    const baseUrl = this.get('NEON_AI_GATEWAY_BASE_URL');
    if (token === undefined || baseUrl === undefined) {
      return { ok: false, modelCount: null, error: 'gateway not configured' };
    }

    try {
      const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/v1/models`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) {
        return { ok: false, modelCount: null, error: `gateway returned ${response.status}` };
      }
      const parsed = modelsSchema.safeParse(await response.json());
      return {
        ok: parsed.success,
        modelCount: parsed.success ? parsed.data.data.length : null,
        ...(parsed.success ? {} : { error: 'unexpected gateway models response' }),
      };
    } catch (error) {
      return {
        ok: false,
        modelCount: null,
        error: error instanceof Error ? error.message : 'fetch failed',
      };
    }
  }

  functionUrl(): string | null {
    const branchId = this.get('NEON_BRANCH_ID');
    const suffix = this.get('NEON_FUNCTION_HOST_SUFFIX');
    if (branchId === undefined || suffix === undefined) {
      return null;
    }
    const hostSuffix = suffix.startsWith('.') ? suffix : `.${suffix}`;
    return `https://${branchId}-hello${hostSuffix}`;
  }

  /** Calls the deployed Function with the shared secret declared in neon.ts. */
  async callHelloFunction(): Promise<{ ok: boolean; status: number; body: string }> {
    const url = this.functionUrl();
    if (url === null) {
      throw new AppError(ERROR_CODES.SERVICE_UNAVAILABLE, undefined, {
        details: { service: 'neon-functions', missing: 'NEON_BRANCH_ID/NEON_FUNCTION_HOST_SUFFIX' },
      });
    }
    const key = this.require('NEON_FUNCTION_API_KEY', 'NEON_FUNCTION_API_KEY');

    const response = await fetch(url, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    });
    return { ok: response.ok, status: response.status, body: await response.text() };
  }

  /**
   * Authorizes the job against the caller's workspace, then seals a read-only
   * live query over its checkpoints. The SQL and filter values are encrypted;
   * the browser never receives the secret or the query text.
   */
  async sealJobCheckpoints(userId: string, jobId: string): Promise<SealedLiveQuery> {
    const secret = this.require('NEON_REALTIME_SECRET', 'NEON_REALTIME_SECRET');
    const db = this.realtimeDatabase();

    const allowed = await getDb()
      .select({ workspaceId: brands.workspaceId })
      .from(generationJobs)
      .innerJoin(posts, eq(posts.id, generationJobs.postId))
      .innerJoin(brands, eq(brands.id, posts.brandId))
      .innerJoin(workspaceMembers, eq(workspaceMembers.workspaceId, brands.workspaceId))
      .where(and(eq(generationJobs.id, jobId), eq(workspaceMembers.userId, userId)))
      .limit(1);

    if (allowed.length === 0) {
      throw new AppError(ERROR_CODES.FORBIDDEN, 'Job is not in one of your workspaces', {
        details: { jobId },
      });
    }

    const query = getDb()
      .select({
        job_id: jobCheckpoints.jobId,
        stage: jobCheckpoints.stage,
        output_ref: jobCheckpoints.outputRef,
        created_at: jobCheckpoints.createdAt,
      })
      .from(jobCheckpoints)
      .where(eq(jobCheckpoints.jobId, jobId))
      .orderBy(jobCheckpoints.createdAt);

    const [realtimeMod, drizzleMod] = await Promise.all([
      importEsm('@neon/realtime/server'),
      importEsm('@neon/realtime-drizzle'),
    ]);
    const realtime = (realtimeMod as unknown as RealtimeModule).createRealtime({
      secret,
      db,
      adapter: (drizzleMod as unknown as RealtimeDrizzleModule).drizzleAdapter(),
    });

    const sealed = await realtime.seal({ query });
    this.sealedQueriesIssued += 1;
    return sealed;
  }

  private realtimeDatabase(): string {
    const configured = this.get('NEON_REALTIME_DATABASE');
    if (configured !== undefined) {
      return configured;
    }
    const url = this.require('DATABASE_URL', 'DATABASE_URL');
    const name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
    if (name === '') {
      throw new AppError(ERROR_CODES.INTERNAL_ERROR, 'DATABASE_URL has no database name');
    }
    return name;
  }
}
