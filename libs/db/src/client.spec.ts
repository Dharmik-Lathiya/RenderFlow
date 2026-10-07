import {
  createDb,
  disconnectDb,
  getDb,
  getDbHandle,
  resetDbForTests,
  shutdownDb,
  type Database,
} from './client';

/**
 * Unit tests for the Drizzle client lifecycle.
 *
 * No database is contacted: a `pg.Pool` opens connections lazily, so these
 * tests verify the wiring - singleton reuse, one pool per process, and clean
 * teardown - without infrastructure. Connection behaviour and the SQL itself are
 * covered by tests/integration against a real Postgres.
 */

const CONFIG = {
  url: 'postgresql://renderflow:renderflow@localhost:5432/renderflow_test',
  logLevels: ['error'] as const,
  statementTimeoutMs: 15_000,
  poolMax: 10,
};

describe('createDb', () => {
  afterEach(() => {
    resetDbForTests();
  });

  it('returns a drizzle handle and its pool', () => {
    const handle = createDb({ ...CONFIG, logLevels: ['error'] });
    expect(handle.db).toBeDefined();
    expect(handle.pool).toBeDefined();
    // No connection is opened until a query runs.
    expect(handle.pool.totalCount).toBe(0);
  });

  it('creates a distinct handle per call', () => {
    expect(createDb({ ...CONFIG, logLevels: ['error'] })).not.toBe(
      createDb({ ...CONFIG, logLevels: ['error'] }),
    );
  });

  it('applies the configured pool size and timeouts', () => {
    const handle = createDb({ ...CONFIG, logLevels: ['error'], poolMax: 3 });
    expect(handle.pool.options.max).toBe(3);
    expect(handle.pool.options.idleTimeoutMillis).toBe(30_000);
    expect(handle.pool.options.statement_timeout).toBe(15_000);
  });
});

describe('getDb / getDbHandle', () => {
  afterEach(() => {
    resetDbForTests();
  });

  it('returns the same handle on repeated calls', () => {
    // Two pools is a common cause of connection exhaustion: a Nest provider and a
    // worker bootstrap that both ask for the client must share one.
    const first = getDbHandle({ ...CONFIG, logLevels: ['error'] });
    const second = getDbHandle({ ...CONFIG, logLevels: ['error'] });
    expect(second).toBe(first);
    expect(getDb()).toBe(first.db);
  });

  it('ignores config passed after the first call', () => {
    const first = getDbHandle({ ...CONFIG, logLevels: ['error'] });
    const other = { ...CONFIG, url: 'postgresql://other:other@localhost:5432/other' };
    expect(getDbHandle({ ...other, logLevels: ['error'] })).toBe(first);
  });

  it('creates a new handle after a reset', () => {
    const first = getDbHandle({ ...CONFIG, logLevels: ['error'] });
    resetDbForTests();
    expect(getDbHandle({ ...CONFIG, logLevels: ['error'] })).not.toBe(first);
  });
});

describe('disconnectDb', () => {
  afterEach(() => {
    resetDbForTests();
  });

  it('is safe to call before any handle was created', async () => {
    await expect(disconnectDb()).resolves.toBeUndefined();
  });

  it('is safe to call twice', async () => {
    getDbHandle({ ...CONFIG, logLevels: ['error'] });
    await expect(disconnectDb()).resolves.toBeUndefined();
    await expect(disconnectDb()).resolves.toBeUndefined();
  });

  it('leaves a fresh handle available afterwards', async () => {
    const first = getDbHandle({ ...CONFIG, logLevels: ['error'] });
    await disconnectDb();
    expect(getDbHandle({ ...CONFIG, logLevels: ['error'] })).not.toBe(first);
  });
});

describe('shutdownDb', () => {
  afterEach(() => {
    resetDbForTests();
  });

  it('closes the pool so a crashed test leaves no open connections', async () => {
    const handle = getDbHandle({ ...CONFIG, logLevels: ['error'] });
    await shutdownDb();
    // `pg` marks an ended pool; a subsequent query would throw.
    expect(handle.pool.ended).toBe(true);
  });
});

describe('module contract', () => {
  it('exports the schema tables consumers depend on', async () => {
    const db = await import('./index');
    // apps/api and libs/credits both import these; this guards against the
    // barrel re-export silently disappearing.
    expect(db.users).toBeDefined();
    expect(db.wallets).toBeDefined();
    expect(db.creditLedger).toBeDefined();
    expect(db.refreshSessions).toBeDefined();
    expect(db.getDb).toBeDefined();
    expect(db.loadDbConfig).toBeDefined();
  });

  it('types the handle as a Database for consumers', () => {
    const typed: Database | undefined = createDb({ ...CONFIG, logLevels: ['error'] }).db;
    expect(typed).toBeDefined();
  });
});
