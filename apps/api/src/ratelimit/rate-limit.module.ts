import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Env } from '../config/env';
import { RATE_LIMIT_CONFIG, RATE_LIMIT_STORE } from './rate-limit.guard';
import { loadRateLimitConfig } from './rate-limit.config';
import { InMemoryRateLimitStore } from './rate-limit.store';

/**
 * Provides rate limit configuration and the store.
 *
 * `@Global` so `APP_GUARD`-registered guards can inject them without every
 * feature module importing this one. Both are behind tokens: swapping in a
 * Redis-backed store means changing `RATE_LIMIT_STORE` here and nothing else,
 * and tests override `RATE_LIMIT_CONFIG` to exercise specific limits.
 *
 * Config is resolved once at construction rather than per request. A malformed
 * limit then fails at boot - visible immediately - instead of on the first
 * request that happens to hit a limited route.
 */
@Global()
@Module({
  providers: [
    {
      provide: RATE_LIMIT_CONFIG,
      useFactory: (configService: ConfigService<Env, true>) => loadRateLimitConfig(configService),
      inject: [ConfigService],
    },
    { provide: RATE_LIMIT_STORE, useFactory: () => new InMemoryRateLimitStore() },
  ],
  exports: [RATE_LIMIT_CONFIG, RATE_LIMIT_STORE],
})
export class RateLimitModule {}
