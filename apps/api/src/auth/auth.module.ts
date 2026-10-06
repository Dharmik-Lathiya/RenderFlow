import { Module } from '@nestjs/common';

import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

/**
 * Auth routes.
 *
 * `AuthGuard` is applied globally in app.module (deny by default), and the CSRF
 * guard protects unsafe methods once a session exists, so neither guard is
 * registered per-route here.
 */
@Module({
  controllers: [AuthController],
  providers: [AuthService],
  exports: [AuthService],
})
export class AuthModule {}
