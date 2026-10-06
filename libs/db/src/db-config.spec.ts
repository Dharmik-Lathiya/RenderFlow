import { DbConfigError, loadDbConfig } from './db-config';

const VALID_URL = 'postgresql://renderflow:renderflow@localhost:5432/renderflow';

describe('loadDbConfig', () => {
  it('requires DATABASE_URL', () => {
    expect(() => loadDbConfig({})).toThrow(DbConfigError);
    expect(() => loadDbConfig({ DATABASE_URL: '  ' })).toThrow(/DATABASE_URL is required/);
  });

  it('accepts postgresql:// and postgres:// URLs', () => {
    expect(loadDbConfig({ DATABASE_URL: VALID_URL }).url).toBe(VALID_URL);
    expect(loadDbConfig({ DATABASE_URL: 'postgres://u:p@h:5432/d' }).url).toContain('postgres://');
  });

  it('rejects a non-postgres URL', () => {
    expect(() => loadDbConfig({ DATABASE_URL: 'mysql://localhost:3306/db' })).toThrow(
      /must be a postgres URL/,
    );
    expect(() => loadDbConfig({ DATABASE_URL: 'not a url' })).toThrow(/not a valid URL/);
  });

  it('defaults to warn+error logging so queries are not logged by default', () => {
    expect(loadDbConfig({ DATABASE_URL: VALID_URL }).logLevels).toEqual(['warn', 'error']);
  });

  it('parses an explicit log level list', () => {
    expect(
      loadDbConfig({ DATABASE_URL: VALID_URL, DB_LOG_LEVELS: 'query, warn ,error' }).logLevels,
    ).toEqual(['query', 'warn', 'error']);
  });

  it('rejects an unrecognised log level list', () => {
    expect(() => loadDbConfig({ DATABASE_URL: VALID_URL, DB_LOG_LEVELS: 'verbose' })).toThrow(
      /comma-separated subset/,
    );
  });

  it('applies a default statement timeout and allows an override', () => {
    expect(loadDbConfig({ DATABASE_URL: VALID_URL }).statementTimeoutMs).toBe(15_000);
    expect(
      loadDbConfig({ DATABASE_URL: VALID_URL, DB_STATEMENT_TIMEOUT_MS: '30000' })
        .statementTimeoutMs,
    ).toBe(30_000);
  });

  it('rejects a nonsensical statement timeout', () => {
    expect(() => loadDbConfig({ DATABASE_URL: VALID_URL, DB_STATEMENT_TIMEOUT_MS: '-1' })).toThrow(
      /positive integer/,
    );
  });
});
