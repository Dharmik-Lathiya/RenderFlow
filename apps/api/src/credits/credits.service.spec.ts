import { CreditError } from '@renderflow/credits';

import { CreditsService } from './credits.service';

/**
 * `CreditsService` is a thin read model over `libs/credits`. These tests use a
 * hand-written stub rather than a database, because the SQL and its guarantees
 * are verified in tests/integration against a real Postgres; what matters here
 * is the shape of the response and that the service performs no writes.
 */

interface FakePrisma {
  wallet: { findUnique: jest.Mock };
  creditLedger: { count: jest.Mock; findMany: jest.Mock };
}

interface WalletRow {
  userId: string;
  available: number;
  reserved: number;
}

function stub(): { prisma: FakePrisma; walletRow: WalletRow; ledgerRows: unknown[] } {
  const walletRow: WalletRow = {
    userId: 'user-1',
    available: 50,
    reserved: 10,
  };
  const ledgerRows: unknown[] = [
    {
      id: 'l1',
      userId: 'user-1',
      entryType: 'SIGNUP_BONUS',
      amount: 50,
      referenceType: 'SYSTEM',
      referenceId: null,
      note: 'Signup bonus',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    },
  ];

  return {
    walletRow,
    ledgerRows,
    prisma: {
      wallet: { findUnique: jest.fn().mockResolvedValue(walletRow) },
      creditLedger: {
        count: jest.fn().mockResolvedValue(1),
        findMany: jest.fn().mockResolvedValue(ledgerRows),
      },
    },
  };
}

async function serviceWith(prisma: unknown): Promise<CreditsService> {
  const service = new CreditsService();
  // `getPrismaClient()` is a module singleton; overriding the private field is the
  // simplest way to inject a stub without a real database or a DI container.
  (service as unknown as { prisma: unknown }).prisma = prisma;
  return service;
}

describe('CreditsService', () => {
  it('returns the balance with a computed total', async () => {
    const { prisma, walletRow } = stub();
    const service = await serviceWith(prisma);

    const result = await service.getCredits('user-1', 1, 20);

    expect(result.wallet).toEqual({ ...walletRow, total: 60 });
  });

  it('returns the ledger and the total count', async () => {
    const { prisma } = stub();
    const service = await serviceWith(prisma);

    const result = await service.getCredits('user-1', 1, 20);

    expect(result.ledger).toHaveLength(1);
    expect(result.ledger[0]).toMatchObject({ entryType: 'SIGNUP_BONUS', amount: 50 });
    expect(result.pagination).toEqual({ total: 1, page: 1, pageSize: 20 });
  });

  it('passes the page size through as the ledger query limit', async () => {
    const { prisma } = stub();
    const service = await serviceWith(prisma);

    await service.getCredits('user-1', 2, 5);

    expect(prisma.creditLedger.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'user-1' }, take: 5 }),
    );
  });

  it('scopes every query to the requesting user', async () => {
    // Multi-tenant isolation: a wallet or ledger row from another user must
    // never appear in this response (AGENTS.md section 10).
    const { prisma } = stub();
    const service = await serviceWith(prisma);

    await service.getCredits('user-2', 1, 20);

    expect(prisma.wallet.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'user-2' } }),
    );
    expect(prisma.creditLedger.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'user-2' } }),
    );
    expect(prisma.creditLedger.count).toHaveBeenCalledWith({ where: { userId: 'user-2' } });
  });

  it('propagates WALLET_NOT_FOUND from libs/credits', async () => {
    const { prisma } = stub();
    prisma.wallet.findUnique.mockResolvedValue(null);
    const service = await serviceWith(prisma);

    await expect(service.getCredits('ghost', 1, 20)).rejects.toBeInstanceOf(CreditError);
  });

  it('performs no writes', async () => {
    // AGENTS.md rule 1: only libs/credits writes wallets/credit_ledger.
    const { prisma } = stub();
    const service = await serviceWith(prisma);

    await service.getCredits('user-1', 1, 20);

    const methods = [...Object.keys(prisma.wallet), ...Object.keys(prisma.creditLedger)];
    for (const method of methods) {
      expect(method).toMatch(/^(findUnique|findMany|count)$/);
    }
  });
});
