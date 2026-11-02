/**
 * Re-exported from `@renderflow/email`.
 *
 * The transports moved into a lib when the publisher worker gained a
 * `notifications` consumer: an app may not import another app's source
 * (AGENTS.md section 3), so the shared seam has to live under `libs/`. This
 * module stays as the API's import path, which keeps the Nest module and the
 * auth call sites untouched.
 */
export * from '@renderflow/email';
