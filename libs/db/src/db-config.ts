/**
 * Database configuration. Read once at the process edge, then passed down.
 *
 * AGENTS.md rule: "Never read `process.env` directly outside the config module."
 */

export interface DbConfig {
  url: string;
  /**
   * Retained from the previous data layer so a misconfigured value still fails
   * fast rather than being silently ignored.
   */
  logLevels: Array<'query' | 'info' | 'warn' | 'error'>;
  /** Statement timeout, so one runaway query cannot exhaust the pool. */
  statementTimeoutMs: number;
  /** Maximum pooled connections. */
  poolMax: number;
}

export class DbConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DbConfigError';
  }
}

const VALID_LOG_LEVELS = ['query', 'info', 'warn', 'error'] as const;
type LogLevel = (typeof VALID_LOG_LEVELS)[number];

const DEFAULT_STATEMENT_TIMEOUT_MS = 15_000;
const DEFAULT_POOL_MAX = 10;

function parseLogLevels(raw: string | undefined): DbConfig['logLevels'] {
  if (!raw || raw.trim() === '') {
    return ['warn', 'error'];
  }
  const levels = raw
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter((value): value is LogLevel => VALID_LOG_LEVELS.includes(value as LogLevel));

  if (levels.length === 0) {
    throw new DbConfigError(
      `DB_LOG_LEVELS must be a comma-separated subset of ${VALID_LOG_LEVELS.join(', ')}`,
    );
  }
  return levels;
}

function parsePositiveInt(raw: string | undefined, name: string, fallback: number): number {
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new DbConfigError(`${name} must be a positive integer, received "${raw}"`);
  }
  return value;
}

export function loadDbConfig(source: NodeJS.ProcessEnv = process.env): DbConfig {
  const url = source.DATABASE_URL?.trim() ?? '';

  if (url === '') {
    throw new DbConfigError('DATABASE_URL is required');
  }

  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    throw new DbConfigError('DATABASE_URL is not a valid URL');
  }

  if (protocol !== 'postgresql:' && protocol !== 'postgres:') {
    throw new DbConfigError(`DATABASE_URL must be a postgres URL, received protocol "${protocol}"`);
  }

  return {
    url,
    logLevels: parseLogLevels(source.DB_LOG_LEVELS),
    statementTimeoutMs: parsePositiveInt(
      source.DB_STATEMENT_TIMEOUT_MS,
      'DB_STATEMENT_TIMEOUT_MS',
      DEFAULT_STATEMENT_TIMEOUT_MS,
    ),
    poolMax: parsePositiveInt(source.DB_POOL_MAX, 'DB_POOL_MAX', DEFAULT_POOL_MAX),
  };
}
