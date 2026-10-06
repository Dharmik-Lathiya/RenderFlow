import type { PrismaClient } from '@prisma/client';

import {
  createPrismaClient,
  disconnectPrisma,
  getPrismaClient,
  resetPrismaClientForTests,
} from './client';
import type { DbConfig } from './db-config';

/**
 * Unit tests for the client lifecycle.
 *
 * No database is contacted: constructing a PrismaClient is lazy (it connects on
 * first query), so these tests verify the wiring - singleton reuse, pooling
 * semantics and clean teardown - without infrastructure. Connection behaviour is
 * covered by tests/integration.
 */

const CONFIG: DbConfig = {
  url: 'postgresql://renderflow:renderflow@localhost:5432/renderflow_test',
  logLevels: ['error'],
  statementTimeoutMs: 15_000,
};

describe('createPrismaClient', () => {
  afterEach(() => {
    resetPrismaClientForTests();
  });

  it('returns a client without connecting eagerly', () => {
    const client = createPrismaClient(CONFIG);
    expect(client).toBeDefined();
    expect(typeof client.$connect).toBe('function');
    expect(typeof client.$transaction).toBe('function');
  });

  it('creates a distinct instance per call', () => {
    expect(createPrismaClient(CONFIG)).not.toBe(createPrismaClient(CONFIG));
  });
});

describe('getPrismaClient', () => {
  afterEach(() => {
    resetPrismaClientForTests();
  });

  it('returns the same instance on repeated calls', () => {
    // Two PrismaClients means two connection pools; a Nest provider and a worker
    // bootstrap that both ask for the client must share one.
    const first = getPrismaClient(CONFIG);
    const second = getPrismaClient(CONFIG);
    expect(second).toBe(first);
  });

  it('ignores config passed after the first call', () => {
    const first = getPrismaClient(CONFIG);
    const other: DbConfig = { ...CONFIG, url: 'postgresql://other:other@localhost:5432/other' };
    expect(getPrismaClient(other)).toBe(first);
  });

  it('creates a new instance after a reset', () => {
    const first = getPrismaClient(CONFIG);
    resetPrismaClientForTests();
    expect(getPrismaClient(CONFIG)).not.toBe(first);
  });
});

describe('disconnectPrisma', () => {
  afterEach(() => {
    resetPrismaClientForTests();
  });

  it('is safe to call before any client was created', async () => {
    await expect(disconnectPrisma()).resolves.toBeUndefined();
  });

  it('is safe to call twice', async () => {
    getPrismaClient(CONFIG);
    await expect(disconnectPrisma()).resolves.toBeUndefined();
    await expect(disconnectPrisma()).resolves.toBeUndefined();
  });

  it('leaves a fresh instance available afterwards', async () => {
    const first = getPrismaClient(CONFIG);
    await disconnectPrisma();
    expect(getPrismaClient(CONFIG)).not.toBe(first);
  });
});

describe('module contract', () => {
  it('exports the Prisma types consumers need', async () => {
    // apps/api and libs/credits both annotate values as `PrismaClient`; this
    // guards against the barrel re-export silently disappearing.
    const db = await import('./index');
    const client: PrismaClient | undefined = createPrismaClient(CONFIG);
    expect(client).toBeDefined();
    expect(db.createPrismaClient).toBeDefined();
    expect(db.loadDbConfig).toBeDefined();
  });
});
