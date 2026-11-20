import { Module } from '@nestjs/common';

import { NeonController } from './neon.controller';
import { NeonService } from './neon.service';

/** Additive Neon integration; it does not replace the app's own auth module. */
@Module({
  controllers: [NeonController],
  providers: [NeonService],
  exports: [NeonService],
})
export class NeonModule {}
