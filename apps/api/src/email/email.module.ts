import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Env } from '../config/env';
import { EMAIL_SENDER, createEmailSender } from './email';

/**
 * Provides the transactional mail transport.
 *
 * `@Global` because the publishers need it too (a failed publish notifies the
 * account owner), and threading an injection token through every feature module
 * would make "email is available" a thing each module has to remember.
 */
@Global()
@Module({
  providers: [
    {
      provide: EMAIL_SENDER,
      useFactory: (config: ConfigService<Env, true>) =>
        createEmailSender(config.get('EMAIL_PROVIDER', { infer: true })),
      inject: [ConfigService],
    },
  ],
  exports: [EMAIL_SENDER],
})
export class EmailModule {}
