import { Controller, Get } from '@nestjs/common';

import { CurrentUser, type AuthenticatedUser } from '../auth/auth.guard';
import { UsersService, type MeResponse } from './users.service';

@Controller()
export class UsersController {
  constructor(private readonly users: UsersService) {}

  /** GET /api/v1/me */
  @Get('me')
  getMe(@CurrentUser() user: AuthenticatedUser): Promise<MeResponse> {
    return this.users.getMe(user.id);
  }
}
