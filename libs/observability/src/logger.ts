import pino, { type DestinationStream, type Logger, type LoggerOptions } from 'pino';

import type { ShutdownLogger } from '@renderflow/common';

/**
 * Shared structured logger.
 *
 * AGENTS.md section 7: "Use the shared pino logger with requestId, userId, jobId,
 * stage. Never log secrets, tokens, or full prompts containing PII."
 *
 * Redaction happens here, in one place, so a new call site cannot accidentally
 * log a token. Two layers:
 *
 *  1. pino's own `redact` for the shallow shapes (top level and one level down);
 *  2. `deepRedact` in the log formatter, which walks the merged object to any
 *     depth. Layer 2 is not optional decoration: the bundled fast-redact does
 *     not implement the `**` recursive wildcard, so depth-limited `redact`
 *     paths alone leak `{ account: { credentials: { accessToken } } }`.
 */

export const REDACTED_FIELD_NAMES = [
  'password',
  'passwordHash',
  'token',
  'tokens',
  'accessToken',
  'refreshToken',
  'idToken',
  'sessionToken',
  'externalPostId',
  'secret',
  'secretAccessKey',
  'accessKeyId',
  'apiKey',
  'authorization',
  'cookie',
  'setCookie',
  'clientSecret',
  'signingKey',
  'privateKey',
  // OAuth authorization codes are single-use credentials.
  'code',
  // Full prompts can carry customer PII.
  'prompt',
] as const;

export const REDACTION_PLACEHOLDER = '[redacted]';

/** Shallow paths handed to pino's redact as a fast path. */
export const REDACTED_PATHS: readonly string[] = [
  ...REDACTED_FIELD_NAMES,
  ...REDACTED_FIELD_NAMES.map((name) => `*.${name}`),
];

/**
 * Normalised lookup so `refresh_token`, `refreshToken` and `refresh-token` are
 * all caught by a single entry.
 */
function normalizeKey(key: string): string {
  return key.replace(/[-_\s]/g, '').toLowerCase();
}

const SENSITIVE_KEYS = new Set(REDACTED_FIELD_NAMES.map(normalizeKey));

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(normalizeKey(key));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

function isRedactableContainer(value: unknown): value is Record<string, unknown> | unknown[] {
  return Array.isArray(value) || isPlainObject(value);
}

/**
 * Returns a copy of `value` with every sensitive field replaced by the
 * placeholder, at any depth and inside arrays. Never mutates the input, never
 * recurses into non-plain objects (Date, Buffer, Error, class instances), and
 * tolerates cycles.
 */
export function deepRedact(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (!isRedactableContainer(value)) {
    return value;
  }

  if (seen.has(value)) {
    return '[circular]';
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => deepRedact(item, seen));
  }

  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    output[key] = isSensitiveKey(key) ? REDACTION_PLACEHOLDER : deepRedact(entry, seen);
  }
  return output;
}

export interface CreateLoggerOptions {
  level?: string;
  /** Logical service name (`api`, `media-worker`, ...). */
  service?: string;
  /** Injection seam for tests: capture lines instead of writing to stdout. */
  destination?: DestinationStream;
  /** Fields added to every line, e.g. { requestId }. */
  base?: Record<string, unknown>;
}

export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const { level = 'info', service = 'renderflow', destination, base } = options;

  const loggerOptions: LoggerOptions = {
    level,
    base: { service, ...base },
    redact: {
      paths: [...REDACTED_PATHS],
      censor: REDACTION_PLACEHOLDER,
    },
    formatters: {
      level: (label) => ({ level: label }),
      // Runs on the fully merged object, so redaction also covers `base` fields.
      log: (object) => deepRedact(object) as Record<string, unknown>,
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  };

  return destination ? pino(loggerOptions, destination) : pino(loggerOptions);
}

/** Convenience factory for a named worker or service. */
export function childLogger(service: string, base: Record<string, unknown> = {}): Logger {
  return createLogger({ service, base });
}

/**
 * Adapts a pino logger to the structural interface expected by
 * `createGracefulShutdown`, so libs/common does not need to depend on pino.
 */
export function toShutdownLogger(logger: Logger): ShutdownLogger {
  return {
    info: (context, message) => logger.info(context, message),
    warn: (context, message) => logger.warn(context, message),
    error: (context, message) => logger.error(context, message),
  };
}

export type { Logger } from 'pino';
