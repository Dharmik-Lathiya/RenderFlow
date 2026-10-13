/**
 * Where the browser finds the API.
 *
 * `NEXT_PUBLIC_*` is the only thing that reaches a client bundle, so the base URL
 * is public by construction and nothing else can leak through it. There are no
 * secrets in this file and there must never be any: the web app authenticates
 * with an httpOnly cookie the browser attaches itself, so it has nothing secret
 * to hold.
 */

/**
 * Read at MODULE LOAD, not per request.
 *
 * `process.env.NEXT_PUBLIC_*` is inlined by Next at build time, so a value read
 * inside a function can still be inlined - but reading it per call would make it
 * look like the value could change at runtime, which it cannot.
 */
const RAW_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1';

export const API_BASE_URL: string = RAW_BASE_URL.replace(/\/+$/, '');

/** True when the API is on another origin, which needs credentialed CORS. */
export const API_IS_CROSS_ORIGIN: boolean = (() => {
  if (typeof window === 'undefined') {
    // During SSR there is no origin to compare against. Requests do not happen
    // in a server component anyway - they are all client components - so the
    // question only matters in the browser.
    return false;
  }

  try {
    return new URL(API_BASE_URL).origin !== window.location.origin;
  } catch {
    return false;
  }
})();

/** The origin the browser should connect SSE to. */
export function eventStreamUrl(path: string): string {
  const base = new URL(API_BASE_URL);

  // Same-origin `/api/v1` proxying means the browser resolves it against the
  // page; an absolute URL to another port does not. Converting explicitly keeps
  // the SSE client from having to know which deployment shape it is in.
  return `${base.origin}${base.pathname.replace(/\/+$/, '')}${path}`;
}
