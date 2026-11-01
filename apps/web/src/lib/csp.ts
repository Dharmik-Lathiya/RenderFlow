/**
 * Content Security Policy construction, separated from the Next proxy so the
 * policy can be unit-tested without a request object.
 */
export function buildContentSecurityPolicy(input: {
  nonce: string;
  isDev: boolean;
  apiOrigin: string;
}): string {
  const { nonce, isDev, apiOrigin } = input;

  const scriptSrc = [
    "'self'",
    `'nonce-${nonce}'`,
    "'strict-dynamic'",
    ...(isDev ? ["'unsafe-eval'"] : []),
  ].join(' ');

  return [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    // CSS Modules emit external stylesheets, but React can still inline a style
    // attribute for transitions. Allowing inline styles does not allow scripts.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "media-src 'self' blob: https:",
    "font-src 'self' data:",
    `connect-src 'self' ${apiOrigin} https:`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(isDev ? [] : ['upgrade-insecure-requests']),
  ].join('; ');
}
