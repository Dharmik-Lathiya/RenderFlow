import { count, eq } from 'drizzle-orm';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { getBalance, listLedger, type LedgerEntry, type WalletBalance } from '@renderflow/credits';
import { creditLedger, getDb, type Database } from '@renderflow/db';

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
  private db!: Database;

  onModuleInit(): void {
    this.db = getDb();
  }

  async getCredits(userId: string, page: number, pageSize: number): Promise<CreditsResponse> {
    const [wallet, ledger, totalRows] = await Promise.all([
      getBalance(this.db, userId),
      listLedger(this.db, userId, pageSize),
      this.db.select({ value: count() }).from(creditLedger).where(eq(creditLedger.userId, userId)),
    ]);

    return {
      wallet,
      ledger,
      pagination: { total: totalRows[0]?.value ?? 0, page, pageSize },
    };
  }
}
