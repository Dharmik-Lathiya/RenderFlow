/**
 * Database configuration. Read once at the process edge, then passed down.
 *
 * AGENTS.md rule: "Never read `process.env` directly outside the config module."
 */

export interface DbConfig {
  url: string;
  /**
   * Prisma log levels. `query` is noisy and must never be enabled in production
   * because bind parameters can contain customer data.
   */
  logLevels: Array<'query' | 'info' | 'warn' | 'error'>;
  /** Statement timeout, so one runaway query cannot exhaust the pool. */
  statementTimeoutMs: number;
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

export function loadDbConfig(env: NodeJS.ProcessEnv = process.env): DbConfig {
  const url = env.DATABASE_URL?.trim() ?? '';

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

  const rawTimeout = env.DB_STATEMENT_TIMEOUT_MS?.trim();
  let statementTimeoutMs = DEFAULT_STATEMENT_TIMEOUT_MS;
  if (rawTimeout) {
    const parsed = Number(rawTimeout);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new DbConfigError(
        `DB_STATEMENT_TIMEOUT_MS must be a positive integer, received "${rawTimeout}"`,
      );
    }
    statementTimeoutMs = parsed;
  }

  return {
    url,
    logLevels: parseLogLevels(env.DB_LOG_LEVELS),
    statementTimeoutMs,
  };
}
