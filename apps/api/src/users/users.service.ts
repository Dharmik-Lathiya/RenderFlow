import { Injectable, type OnModuleInit } from '@nestjs/common';
import { AppError, ERROR_CODES, type UserRole } from '@renderflow/common';
import { getPrismaClient, type PrismaClient } from '@renderflow/db';

export interface MeResponse {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  createdAt: string;
}

/**
 * GET /api/v1/me - the authenticated user's profile.
 *
 * Fields are selected explicitly rather than returning the row, so `passwordHash`
 * can never be serialised into a response by accident.
 */
@Injectable()
export class UsersService implements OnModuleInit {
  private prisma!: PrismaClient;

  onModuleInit(): void {
    this.prisma = getPrismaClient();
  }

  async getMe(userId: string): Promise<MeResponse> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, name: true, role: true, createdAt: true },
    });

    if (user === null) {
      // The token is valid but the account is gone: treat it as unauthenticated.
      throw new AppError(ERROR_CODES.UNAUTHORIZED, 'Account no longer exists');
    }

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      createdAt: user.createdAt.toISOString(),
    };
  }
}
