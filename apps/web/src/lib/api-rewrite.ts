/**
 * Server-side resolution of the API upstream.
 *
 * The browser base URL (`NEXT_PUBLIC_API_URL`) is intentionally relative in
 * production so auth cookies stay first-party. That value must NEVER be used as
 * a rewrite destination: a relative destination rewrites `/api/v1/*` back to
 * itself and Next resolves the loop to `/_not-found`.
 *
 * `next.config.ts` evaluates this at BUILD time. Changing `API_INTERNAL_URL`
 * requires a new Vercel deployment.
 */
export type ApiRewriteEnv = Record<string, string | undefined>;

const LOCAL_API_URL = 'http://localhost:4000/api/v1';
const RENDER_API_URL = 'https://renderflow-api.onrender.com/api/v1';

function absoluteHttpUrl(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    return undefined;
  }
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

function withoutTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

/**
 * The complete `/api/v1` base URL the Next rewrite proxies to.
 *
 * `API_INTERNAL_URL` wins. An absolute `NEXT_PUBLIC_API_URL` is accepted for
 * older deployments where the browser calls the API directly; a relative one is
 * ignored. Production falls back to the checked-in Render service so a missing
 * dashboard variable cannot silently turn the proxy into a 404 loop.
 */
export function apiUpstreamUrl(env: ApiRewriteEnv = process.env): string {
  const explicit =
    absoluteHttpUrl(env.API_INTERNAL_URL) ?? absoluteHttpUrl(env.NEXT_PUBLIC_API_URL);
  if (explicit !== undefined) {
    return withoutTrailingSlash(explicit);
  }
  return env.NODE_ENV === 'production' ? RENDER_API_URL : LOCAL_API_URL;
}

/** Origin form for CSP `connect-src`. */
export function apiUpstreamOrigin(env: ApiRewriteEnv = process.env): string {
  return new URL(apiUpstreamUrl(env)).origin;
}

/** Destination for `rewrites()`: the matched `:path*` is appended. */
export function apiRewriteDestination(env: ApiRewriteEnv = process.env): string {
  return `${apiUpstreamUrl(env)}/:path*`;
}
