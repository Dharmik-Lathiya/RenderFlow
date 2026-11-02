import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ValidationFailedError } from '@renderflow/common';

import { CurrentUser, type AuthenticatedUser } from '../auth/auth.guard';
import { RATE_LIMIT_RULES, RateLimitByUser } from '../ratelimit/rate-limit.guard';
import { createFestivalSchema, estimateQuerySchema, FestivalService } from './festival.service';

const uuidParam = new ParseUUIDPipe({ version: '4' });

@ApiTags('festival')
@Controller()
export class FestivalController {
  constructor(private readonly festival: FestivalService) {}

  @Get('festival/occasions')
  @ApiOperation({ summary: 'Active festival occasions' })
  occasions() {
    return this.festival.occasions();
  }

  @Get('festival/templates')
  @ApiOperation({ summary: 'Active templates for one occasion' })
  templates(@Query('occasion') occasion: string | undefined) {
    if (occasion === undefined || occasion.trim() === '') {
      throw new ValidationFailedError({ occasion: 'occasion is required' });
    }
    return this.festival.templates(occasion.trim());
  }

  @Get('festival/estimate')
  @ApiOperation({ summary: 'Server-side credit estimate for a festival generation' })
  estimate(@Query() query: unknown) {
    const parsed = estimateQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new ValidationFailedError(
        Object.fromEntries(
          parsed.error.issues.map((issue) => [
            issue.path.length > 0 ? issue.path.join('.') : '(query)',
            issue.message,
          ]),
        ),
      );
    }
    return this.festival.estimate(parsed.data.includeReel);
  }

  @RateLimitByUser(RATE_LIMIT_RULES.GENERATE_USER)
  @Post('campaigns/:campaignId/festival')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Create a festival generation; reserves credits and creates the post atomically',
  })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('campaignId', uuidParam) campaignId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ) {
    const parsed = createFestivalSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationFailedError(
        Object.fromEntries(
          parsed.error.issues.map((issue) => [
            issue.path.length > 0 ? issue.path.join('.') : '(body)',
            issue.message,
          ]),
        ),
      );
    }

    return this.festival.create(user.id, campaignId, parsed.data, idempotencyKey);
  }
}
