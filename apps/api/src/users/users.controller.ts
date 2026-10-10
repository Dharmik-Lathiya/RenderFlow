import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Controller, Get } from '@nestjs/common';

import { CurrentUser, type AuthenticatedUser } from '../auth/auth.guard';
import { UsersService, type MeResponse } from './users.service';

@ApiTags('users')
@Controller()
export class UsersController {
  constructor(private readonly users: UsersService) {}

  /** GET /api/v1/me */
  @Get('me')
  @ApiOperation({ summary: 'The authenticated user profile' })
  getMe(@CurrentUser() user: AuthenticatedUser): Promise<MeResponse> {
    return this.users.getMe(user.id);
  }
}
