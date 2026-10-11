import { Module } from '@nestjs/common';

import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';

/**
 * Operator endpoints: the dead-letter queue and ledger reconciliation.
 *
 * A separate module rather than an extension of `JobsModule`, because the two
 * have opposite natures: jobs are about producing media, and the admin surface
 * is about money that has already moved. Keeping them apart means a change to
 * how a generation runs cannot quietly change who can see a refunded balance.
 */
@Module({
  controllers: [AdminController],
  providers: [AdminService],
  exports: [AdminService],
})
export class AdminModule {}
