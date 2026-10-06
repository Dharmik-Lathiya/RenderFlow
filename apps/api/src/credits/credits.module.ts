import { Module } from '@nestjs/common';

import { CreditsController } from './credits.controller';
import { CreditsService } from './credits.service';

/**
 * Credit READS only.
 *
 * Mutations live in `libs/credits` and are invoked by the jobs module in Phase 4,
 * always inside the transaction that creates the job (AGENTS.md rule 9).
 */
@Module({
  controllers: [CreditsController],
  providers: [CreditsService],
  exports: [CreditsService],
})
export class CreditsModule {}
