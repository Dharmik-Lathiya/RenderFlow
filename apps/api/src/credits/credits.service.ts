import { Injectable, type OnModuleInit } from '@nestjs/common';
import { getBalance, listLedger, type LedgerEntry, type WalletBalance } from '@renderflow/credits';
import { getPrismaClient, type PrismaClient } from '@renderflow/db';

export interface CreditsResponse {
  wallet: WalletBalance;
  ledger: LedgerEntry[];
  pagination: {
    total: number;
    page: number;
    pageSize: number;
  };
}

/**
 * Read-only credit views (PROJECT.md section 10: `GET /credits`).
 *
 * This service deliberately performs no writes: `wallets` and `credit_ledger` may
 * only be written by `libs/credits` (AGENTS.md rule 1).
 */
@Injectable()
export class CreditsService implements OnModuleInit {
  private prisma!: PrismaClient;

  onModuleInit(): void {
    this.prisma = getPrismaClient();
  }

  async getCredits(userId: string, page: number, pageSize: number): Promise<CreditsResponse> {
    const [wallet, ledger, total] = await Promise.all([
      getBalance(this.prisma, userId),
      listLedger(this.prisma, userId, pageSize),
      this.prisma.creditLedger.count({ where: { userId } }),
    ]);

    return {
      wallet,
      ledger,
      pagination: { total, page, pageSize },
    };
  }
}
