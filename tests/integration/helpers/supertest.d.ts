import 'supertest';

/**
 * Type augmentation for supertest.
 *
 * `Response.body` is declared as `any`, which disables every type-aware ESLint
 * rule on any test that reads a response body and makes `res.body.user.email`
 * silently unchecked. Narrowing it to `Record<string, unknown>` means each field
 * access yields `unknown`, so assertions have to say what shape they expect and
 * typos in field names become compile errors.
 */
declare module 'supertest' {
  interface Response {
    body: Record<string, unknown>;
  }
}
