import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentUser, type AuthenticatedUser } from '../auth/auth.guard';
import { AnalyticsService } from './analytics.service';

const uuidParam = new ParseUUIDPipe({ version: '4' });

/**
 * Analytics reads (PROJECT.md section 10: `GET /analytics/campaigns/:id`).
 *
 * `GET /analytics/overview` is an addition to the documented surface: the
 * analytics page needs one workspace-wide answer, and fetching every campaign's
 * endpoint to add the numbers up in the browser would be both slower and a
 * second implementation of the same sum.
 */
@ApiTags('analytics')
@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('campaigns/:campaignId')
  @ApiOperation({
    summary: 'Totals, latest per-publication metrics, a daily series and next-post suggestions',
  })
  campaign(
    @CurrentUser() user: AuthenticatedUser,
    @Param('campaignId', uuidParam) campaignId: string,
  ) {
    return this.analytics.campaign(user.id, campaignId);
  }

  @Get('overview')
  @ApiOperation({ summary: 'Workspace-wide totals, by campaign' })
  overview(
    @CurrentUser() user: AuthenticatedUser,
    @Query('workspaceId', new ParseUUIDPipe({ version: '4' })) workspaceId: string,
  ) {
    return this.analytics.workspace(user.id, workspaceId);
  }
}
