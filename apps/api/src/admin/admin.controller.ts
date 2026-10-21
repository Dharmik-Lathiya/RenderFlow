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

import { ValidationFailedError } from '@renderflow/common';

import { CurrentUser, type AuthenticatedUser } from '../auth/auth.guard';
import { AdminService, adjustSchema, replaySchema, type OperatorScope } from './admin.service';

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
   * Two kinds of operator, both real:
   *
   *  - a global `ADMIN` (`users.role`), who sees every workspace;
   *  - a workspace `OWNER`, who sees only the workspaces they own.
   *
   * The earlier version treated every owner as global. That was wrong for a
   * multi-tenant product - it let one customer's owner replay another's job and
   * read their failure - and it is why the service now scopes in SQL and
   * re-checks before every mutation.
   */
  private async assertOperator(user: AuthenticatedUser): Promise<OperatorScope> {
    return this.admin.requireOperator(user.id);
  }

  @Get('dlq')
  @ApiOperation({ summary: 'Jobs that exhausted their attempts and were refunded' })
  async listJobs(@CurrentUser() user: AuthenticatedUser, @Query('limit') limit?: string) {
    const scope = await this.assertOperator(user);
    return { jobs: await this.admin.listJobs(scope, bounded(limit, 25, 100)) };
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
    const scope = await this.assertOperator(user);

    const parsed = replaySchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new ValidationFailedError({ body: 'must be an object with an optional `reason`' });
    }

    return this.admin.replayJob(scope, jobId, parsed.data.reason);
  }

  @Get('dlq/outbox')
  @ApiOperation({ summary: 'Outbox events the relay gave up on' })
  async listOutbox(@CurrentUser() user: AuthenticatedUser, @Query('limit') limit?: string) {
    const scope = await this.assertOperator(user);
    const maxAttempts = Number(process.env.OUTBOX_MAX_ATTEMPTS ?? 10);
    return { events: await this.admin.listOutbox(scope, maxAttempts, bounded(limit, 50, 200)) };
  }

  @Post('dlq/outbox/:eventId/replay')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Put an abandoned event back in the pending set' })
  async replayOutbox(
    @CurrentUser() user: AuthenticatedUser,
    @Param('eventId', uuidParam) eventId: string,
  ) {
    const scope = await this.assertOperator(user);
    return this.admin.replayOutboxEvent(scope, eventId);
  }

  @Get('reconcile')
  @ApiOperation({ summary: 'Per-bucket wallet/ledger reconciliation' })
  async reconcile(@CurrentUser() user: AuthenticatedUser) {
    const scope = await this.assertOperator(user);
    return this.admin.reconcile(scope);
  }

  /**
   * Manual credit adjustment (PROJECT.md section 10).
   *
   * A POST because it moves money. The body carries a mandatory reason and an
   * optional idempotency reference; both are recorded in the ledger and the
   * audit log.
   */
  @Post('credits/adjust')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Grant or remove credits, audited',
    description:
      'Requires a reason. Retrying with the same `referenceId` does not apply the ' +
      'adjustment twice; the ledger’s unique reference is the mechanism.',
  })
  async adjust(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    const scope = await this.assertOperator(user);

    const parsed = adjustSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationFailedError(
        Object.fromEntries(
          parsed.error.issues.map((issue) => [issue.path.join('.') || '(body)', [issue.message]]),
        ),
      );
    }

    return this.admin.adjustCredits(scope, parsed.data);
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
