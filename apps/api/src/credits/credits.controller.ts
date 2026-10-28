import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  HttpStatus,
  ParseIntPipe,
  Post,
  Query,
} from '@nestjs/common';
import type { WalletBalance } from '@renderflow/credits';

import { CurrentUser, Public, type AuthenticatedUser } from '../auth/auth.guard';
import { RATE_LIMIT_RULES, RateLimitByUser } from '../ratelimit/rate-limit.guard';
import { CreditsService, type CreditsResponse, type PricingResponse } from './credits.service';

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

/**
 * GET /api/v1/credits - balance plus paginated ledger.
 *
 * The balance shown is the wallet cache; every row that produced it is returned
 * alongside so a user (and a support engineer) can audit it.
 */
@ApiTags('credits')
@Controller('credits')
export class CreditsController {
  constructor(private readonly credits: CreditsService) {}

  /**
   * Public: the marketing site renders these numbers instead of restating them.
   *
   * Declared before `@Get()` for readability only - Nest matches on the full
   * path either way - and cached briefly because a price change does not need to
   * be visible within milliseconds.
   */
  @Public()
  @Get('pricing')
  @ApiOperation({ summary: 'Active credit prices and the signup bonus' })
  @Header('Cache-Control', 'public, max-age=60')
  async getPricing(): Promise<PricingResponse> {
    return this.credits.getPricing();
  }

  /**
   * POST /api/v1/credits/top-up - the stub purchase path.
   *
   * 503 unless BILLING_PROVIDER=stub, and that value is refused in production at
   * boot. The response carries the new balance so the client does not have to
   * refetch to know whether it worked.
   */
  @Post('top-up')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Buy a credit pack (stub provider; disabled by default)' })
  @RateLimitByUser(RATE_LIMIT_RULES.TOPUP_USER)
  async topUp(
    @CurrentUser() user: AuthenticatedUser,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ): Promise<{ wallet: WalletBalance; applied: boolean }> {
    return this.credits.topUp(user.id, idempotencyKey);
  }

  @Get()
  @ApiOperation({ summary: 'Wallet balance and paginated credit ledger' })
  async getCredits(
    @CurrentUser() user: AuthenticatedUser,
    @Query('page', new ParseIntPipe({ optional: true })) page?: number,
    @Query('pageSize', new ParseIntPipe({ optional: true })) pageSize?: number,
  ): Promise<CreditsResponse> {
    const safePage = page !== undefined && page > 0 ? page : 1;
    const safePageSize =
      pageSize !== undefined && pageSize > 0
        ? Math.min(pageSize, MAX_PAGE_SIZE)
        : DEFAULT_PAGE_SIZE;
    return this.credits.getCredits(user.id, safePage, safePageSize);
  }
}
