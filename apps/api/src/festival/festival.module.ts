import { Module } from '@nestjs/common';

import { JobsModule } from '../jobs/jobs.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { FestivalController } from './festival.controller';
import { FestivalService } from './festival.service';

/**
 * Festival marketing.
 *
 * Depends on `ModerationService` from JobsModule rather than re-implementing the
 * pre-reservation check, and on `WorkspaceAccessService` for campaign tenancy.
 * The creation transaction itself lives here because festival has a post and a
 * template snapshot that ordinary generation does not.
 */
@Module({
  imports: [JobsModule, WorkspacesModule],
  controllers: [FestivalController],
  providers: [FestivalService],
  exports: [FestivalService],
})
export class FestivalModule {}
