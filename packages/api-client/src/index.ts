/**
 * @renderflow/api-client
 *
 * The single typed HTTP client for RenderFlow front ends. apps/web consumes it
 * today; a future apps/mobile consumes the identical module (PROJECT.md 3.1),
 * which is why auth supports both httpOnly cookies and a bearer token.
 */

export * from './client';
export * from './types';
