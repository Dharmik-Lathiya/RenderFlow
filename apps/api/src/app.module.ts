import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';

import { envSchema } from './config/env';
import { RateLimitGuard } from './ratelimit/rate-limit.guard';
import { RateLimitModule } from './ratelimit/rate-limit.module';
import { AuthGuard, RolesGuard } from './auth/auth.guard';
import { CSRF_OPTIONS, CsrfGuard } from './auth/csrf.guard';
import { AuthModule } from './auth/auth.module';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { OpenApiModule } from './common/openapi';
import { CreditsModule } from './credits/credits.module';
import { HealthModule } from './health/health.module';
import { JobsModule } from './jobs/jobs.module';
import { MetricsModule } from './metrics/metrics.module';
import { WorkspacesModule } from './workspaces/workspaces.module';
import { UsersModule } from './users/users.module';

/**
 * Root module.
 *
 * Guards are registered globally so the default is DENY (AGENTS.md section 10:
 * "Authorization checks on every workspace-scoped query"). A route opts out with
 * `@Public()` rather than opting in, so a forgotten guard fails closed.
 *
 * Order matters: AuthGuard runs before RolesGuard (roles are meaningless without
 * an identity), and CsrfGuard runs before either so a cross-site request is
 * rejected before it can be authenticated.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      // Fail at boot on a bad config rather than at first request.
      validate: (config: Record<string, unknown>) => envSchema.parse(config),
    }),
    RateLimitModule,
    AuthModule,
    OpenApiModule,
    WorkspacesModule,
    UsersModule,
    CreditsModule,
    HealthModule,
    JobsModule,
    MetricsModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    // CsrfGuard needs its exempt list as a provider: an APP_GUARD is constructed
    // by Nest, so a bare constructor parameter would be an unresolvable
    // dependency rather than a default value.
    {
      provide: CSRF_OPTIONS,
      useValue: { exemptPaths: ['/auth/login', '/auth/register'] } as const,
    },
    // RateLimitGuard runs FIRST, ahead of CSRF and authentication: the work it
    // protects is ~50ms of argon2 per login, which has already been spent by the
    // time any handler runs. Limiting after the hash would bound the database
    // but not the CPU, which is the actual denial-of-service surface here.
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
