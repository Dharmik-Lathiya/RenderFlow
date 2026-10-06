import { z } from 'zod';

/**
 * Idempotency keys arrive from clients as an HTTP header (PROJECT.md section 9.5)
 * and are stored with a unique constraint on `generation_jobs.idempotency_key`
 * and `publish_jobs.idempotency_key`.
 *
 * Restricted to a conservative character set so a key can be logged, put in a
 * URL, and used as a lookup key without escaping surprises.
 */
export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

export const IDEMPOTENCY_KEY_MIN_LENGTH = 8;
export const IDEMPOTENCY_KEY_MAX_LENGTH = 200;

export const idempotencyKeySchema = z
  .string()
  .min(IDEMPOTENCY_KEY_MIN_LENGTH)
  .max(IDEMPOTENCY_KEY_MAX_LENGTH)
  .regex(/^[A-Za-z0-9._:-]+$/, 'idempotency key must contain only [A-Za-z0-9._:-]');

export function isValidIdempotencyKey(value: unknown): value is string {
  return idempotencyKeySchema.safeParse(value).success;
}

export function parseIdempotencyKey(value: unknown): string {
  return idempotencyKeySchema.parse(value);
}
