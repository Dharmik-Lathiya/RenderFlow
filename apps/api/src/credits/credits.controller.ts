import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Controller, Get, ParseIntPipe, Query } from '@nestjs/common';

import { CurrentUser, type AuthenticatedUser } from '../auth/auth.guard';
import { CreditsService, type CreditsResponse } from './credits.service';

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
