import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';

import { AppError, ERROR_CODES, ValidationFailedError } from '@renderflow/common';

import { CurrentUser, type AuthenticatedUser } from '../auth/auth.guard';
import { AdminService, replaySchema } from './admin.service';

const uuidParam = new ParseUUIDPipe({ version: '4' });

/**
 * Operator endpoints: the DLQ and reconciliation (PROJECT.md sections 9.7, 9.9).
 *
 * Thin on purpose. The controller parses, delegates and refuses; every decision
 * lives in `AdminService` so it can be asserted without an HTTP round trip.
 */
@ApiTags('admin')
@Controller('admin')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  /**
   * Who may call these.
   *
   * A workspace OWNER. Deliberately not a global admin role: this system has no
   * global role, and inventing one that bypassed tenancy would contradict the
   * rule every other endpoint follows (AGENTS.md section 10).
   *
   * Recorded limitation: these queries are NOT yet filtered by workspace, so an
   * owner sees the whole queue. That is wrong for a multi-tenant product and is
   * called out in PROJECT.md's Phase 5 gaps rather than quietly shipped.
   */
  private async assertOperator(user: AuthenticatedUser): Promise<void> {
    if (!(await this.admin.isOperator(user.id))) {
      throw new AppError(ERROR_CODES.FORBIDDEN, 'Workspace OWNER role required', {
        details: { required: 'OWNER' },
      });
    }
  }

  @Get('dlq')
  @ApiOperation({ summary: 'Jobs that exhausted their attempts and were refunded' })
  async listJobs(@CurrentUser() user: AuthenticatedUser, @Query('limit') limit?: string) {
    await this.assertOperator(user);
    return { jobs: await this.admin.listJobs(bounded(limit, 25, 100)) };
  }

  @Post('dlq/:jobId/replay')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Re-reserve and re-queue a failed job',
    description:
      'The original reservation was refunded, so a replay re-charges the owner. ' +
      'Refused with INSUFFICIENT_CREDITS if they no longer have the credits.',
  })
  async replayJob(
    @CurrentUser() user: AuthenticatedUser,
    @Param('jobId', uuidParam) jobId: string,
    @Body() body: unknown,
  ) {
    await this.assertOperator(user);

    const parsed = replaySchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new ValidationFailedError({ body: 'must be an object with an optional `reason`' });
    }

    return this.admin.replayJob(jobId, parsed.data.reason);
  }

  @Get('dlq/outbox')
  @ApiOperation({ summary: 'Outbox events the relay gave up on' })
  async listOutbox(@CurrentUser() user: AuthenticatedUser, @Query('limit') limit?: string) {
    await this.assertOperator(user);
    const maxAttempts = Number(process.env.OUTBOX_MAX_ATTEMPTS ?? 10);
    return { events: await this.admin.listOutbox(maxAttempts, bounded(limit, 50, 200)) };
  }

  @Post('dlq/outbox/:eventId/replay')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Put an abandoned event back in the pending set' })
  async replayOutbox(
    @CurrentUser() user: AuthenticatedUser,
    @Param('eventId', uuidParam) eventId: string,
  ) {
    await this.assertOperator(user);
    return this.admin.replayOutboxEvent(eventId);
  }

  @Get('reconcile')
  @ApiOperation({ summary: 'Per-bucket wallet/ledger reconciliation' })
  async reconcile(@CurrentUser() user: AuthenticatedUser) {
    await this.assertOperator(user);
    return this.admin.reconcile();
  }
}

/** A bounded integer from a query string, with a clear error rather than a NaN. */
function bounded(raw: string | undefined, fallback: number, max: number): number {
  const parsed = z.coerce
    .number()
    .int()
    .min(1)
    .max(max)
    .safeParse(raw ?? fallback);

  if (!parsed.success) {
    throw new ValidationFailedError({ limit: `must be an integer between 1 and ${max}` });
  }

  return parsed.data;
}
