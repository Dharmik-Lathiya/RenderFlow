import { Module } from '@nestjs/common';

import { JobsController } from './jobs.controller';
import { JobsService } from './jobs.service';

/**
 * Generation requests and progress.
 *
 * The only thing this module does on the way in is reserve credits and write the
 * `job.created` outbox event, both in one transaction. It never pushes to a queue
 * (AGENTS.md rule 6) and never runs a provider: the outbox relay picks the event
 * up, a worker executes the stages, and this module only reports on the result.
 */
@Module({
  controllers: [JobsController],
  providers: [JobsService],
  exports: [JobsService],
})
export class JobsModule {}
