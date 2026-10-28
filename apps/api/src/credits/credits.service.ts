import { randomUUID } from 'node:crypto';

import { count, eq } from 'drizzle-orm';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppError, ERROR_CODES } from '@renderflow/common';
import {
  getBalance,
  listActivePrices,
  listLedger,
  purchase,
  type LedgerEntry,
  type PriceQuote,
  type WalletBalance,
} from '@renderflow/credits';
import { creditLedger, getDb, type Database, type DbTransaction } from '@renderflow/db';

import type { Env } from '../config/env';

export interface PricingResponse {
  /** From SIGNUP_BONUS_CREDITS, so marketing cannot drift from the grant. */
  signupBonus: number;
  prices: PriceQuote[];
}

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

  constructor(private readonly config: ConfigService<Env, true>) {}

  onModuleInit(): void {
    this.db = getDb();
  }

  /**
   * What an anonymous visitor is allowed to know about pricing.
   *
   * Public because a pricing page that requires an account cannot answer "what
   * will this cost" for the person deciding whether to make one. The signup bonus
   * comes from configuration rather than from copy, so the number on the page is
   * the number the grant actually uses.
   */
  async getPricing(): Promise<PricingResponse> {
    return {
      signupBonus: this.config.get('SIGNUP_BONUS_CREDITS', { infer: true }),
      prices: await listActivePrices(this.db),
    };
  }

  /**
   * The wallet alone, for callers that bootstrap a session (the auth profile
   * endpoint) and do not need the ledger page.
   */
  async getWallet(userId: string): Promise<WalletBalance> {
    return getBalance(this.db, userId);
  }

  /**
   * The stub top-up (PROJECT.md section 1: "a stub top-up endpoint is enough").
   *
   * Disabled by default and refused in production at boot. It exists so the
   * PURCHASE ledger path is exercised end to end - the same `purchase()` a real
   * provider adapter will call - rather than left untested until launch.
   *
   * Idempotent on the client's `Idempotency-Key`: a retried request returns the
   * same balance and applies nothing. Without a key each call is a separate
   * order, which is what a real checkout would be.
   */
  async topUp(
    userId: string,
    idempotencyKey: string | undefined,
  ): Promise<{ wallet: WalletBalance; applied: boolean }> {
    const provider = this.config.get('BILLING_PROVIDER', { infer: true });

    if (provider === 'disabled') {
      throw new AppError(
        ERROR_CODES.SERVICE_UNAVAILABLE,
        'Buying credits is not enabled in this deployment.',
      );
    }

    const credits = this.config.get('TOPUP_CREDITS', { infer: true });
    const referenceId = idempotencyKey?.trim() || randomUUID();

    const applied = await this.db.transaction(async (tx: DbTransaction) => {
      const result = await purchase(tx, { userId, credits, referenceId, provider: 'stub' });
      return result.applied;
    });

    return { wallet: await getBalance(this.db, userId), applied };
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
