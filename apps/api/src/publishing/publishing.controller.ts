import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ValidationFailedError } from '@renderflow/common';
import { z } from 'zod';

import { CurrentUser } from '../auth/auth.guard';
import type { AuthenticatedUser } from '../auth/auth.guard';
import { NotificationsService } from './notifications.service';
import { PublishingService, rescheduleSchema, scheduleSchema } from './publishing.service';
import { SocialAccountsService, connectAccountSchema } from './social-accounts.service';

const uuidParam = new ParseUUIDPipe({ version: '4' });

const listAccountsSchema = z.object({ workspaceId: z.uuid() });
const listNotificationsSchema = z.object({
  unread: z.coerce.boolean().default(false),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/**
 * Scheduling, connected accounts and notifications (Phase 7).
 *
 * Three resources on one controller because they are one workflow: connect an
 * account, approve a post, schedule it, then watch it publish. Splitting them
 * would put three files in front of a sequence a user performs in one sitting.
 *
 * Every route takes the caller from the access token, never from the body, and
 * tenancy is resolved inside the services - see `WorkspaceAccessService` for why
 * it is not a guard.
 */
@ApiTags('publishing')
@Controller()
export class PublishingController {
  constructor(
    private readonly publishing: PublishingService,
    private readonly accounts: SocialAccountsService,
    private readonly notifications: NotificationsService,
  ) {}

  // --- scheduling ---------------------------------------------------------

  @Post('posts/:postId/schedule')
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiOperation({
    summary: 'Schedule an approved post to one or more connected accounts',
  })
  schedule(
    @CurrentUser() user: AuthenticatedUser,
    @Param('postId', uuidParam) postId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ) {
    return this.publishing.schedule(user.id, postId, parse(scheduleSchema, body), idempotencyKey);
  }

  @Get('posts/:postId/publishes')
  @ApiOperation({ summary: 'The publish history for a post' })
  listPublishes(
    @CurrentUser() user: AuthenticatedUser,
    @Param('postId', uuidParam) postId: string,
  ) {
    return this.publishing.listForPost(user.id, postId);
  }

  @Delete('posts/:postId/schedule')
  @ApiOperation({ summary: 'Cancel everything still pending for a post' })
  cancel(@CurrentUser() user: AuthenticatedUser, @Param('postId', uuidParam) postId: string) {
    return this.publishing.cancel(user.id, postId);
  }

  @Patch('posts/:postId/schedule')
  @ApiOperation({
    summary: 'Move a scheduled post to a new time (APPROVER+)',
    description:
      'Updates `publish_jobs.scheduled_for` for every job that has not started. ' +
      'The publisher claims from the row, so an earlier time is picked up by the ' +
      'publisher poll and a later time ignores the stale delayed wake-up.',
  })
  reschedule(
    @CurrentUser() user: AuthenticatedUser,
    @Param('postId', uuidParam) postId: string,
    @Body() body: unknown,
  ) {
    const parsed = rescheduleSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationFailedError({ scheduledAt: ['must be an ISO 8601 instant'] });
    }
    return this.publishing.reschedule(user.id, postId, parsed.data);
  }

  // --- connected accounts -------------------------------------------------

  @Post('social-accounts')
  @ApiOperation({ summary: 'Connect a social account, or rotate its token' })
  connect(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    return this.accounts.connect(user.id, parse(connectAccountSchema, body));
  }

  @Get('social-accounts')
  @ApiOperation({ summary: 'List the accounts a workspace publishes to' })
  listAccounts(@CurrentUser() user: AuthenticatedUser, @Query() query: unknown) {
    const { workspaceId } = parse(listAccountsSchema, query);
    return this.accounts.list(user.id, workspaceId);
  }

  @Delete('social-accounts/:accountId')
  @ApiOperation({ summary: 'Disconnect an account' })
  disconnect(
    @CurrentUser() user: AuthenticatedUser,
    @Param('accountId', uuidParam) accountId: string,
  ) {
    return this.accounts.disconnect(user.id, accountId);
  }

  // --- notifications ------------------------------------------------------

  @Get('notifications')
  @ApiOperation({ summary: 'My notifications, newest first' })
  listNotifications(@CurrentUser() user: AuthenticatedUser, @Query() query: unknown) {
    const { unread, limit } = parse(listNotificationsSchema, query);
    return this.notifications.list(user.id, unread, limit);
  }

  @Get('notifications/unread-count')
  @ApiOperation({ summary: 'How many notifications are unread' })
  unreadCount(@CurrentUser() user: AuthenticatedUser) {
    return this.notifications.countUnread(user.id).then((count) => ({ count }));
  }

  @Post('notifications/:notificationId/read')
  @ApiOperation({ summary: 'Mark one notification read' })
  markRead(
    @CurrentUser() user: AuthenticatedUser,
    @Param('notificationId', uuidParam) notificationId: string,
  ) {
    return this.notifications.markRead(user.id, notificationId);
  }

  @Post('notifications/read-all')
  @ApiOperation({ summary: 'Mark every notification read' })
  markAllRead(@CurrentUser() user: AuthenticatedUser) {
    return this.notifications.markAllRead(user.id);
  }
}

/** One parse path for every body and query on this controller. */
function parse<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input);

  if (!result.success) {
    throw new ValidationFailedError(result.error.issues);
  }

  return result.data;
}
