import { Global, Module } from '@nestjs/common';

import { NotificationsService } from './notifications.service';
import { PublishingController } from './publishing.controller';
import { PublishingService } from './publishing.service';
import { SocialAccountsService } from './social-accounts.service';

/**
 * Scheduling, connected social accounts and notifications (Phase 7).
 *
 * `@Global` for the same reason `WorkspacesModule` is: `apps/publisher-worker`
 * and the notification path need `NotificationsService`, and an app importing a
 * second module to reach it is a dependency that has to be remembered.
 */
@Global()
@Module({
  controllers: [PublishingController],
  providers: [PublishingService, SocialAccountsService, NotificationsService],
  exports: [PublishingService, SocialAccountsService, NotificationsService],
})
export class PublishingModule {}
