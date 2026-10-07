import { eq } from 'drizzle-orm';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { AppError, ERROR_CODES, type UserRole } from '@renderflow/common';
import { getDb, users, type Database } from '@renderflow/db';

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
  private db!: Database;

  onModuleInit(): void {
    this.db = getDb();
  }

  async getMe(userId: string): Promise<MeResponse> {
    const rows = await this.db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        role: users.role,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    const user = rows[0];

    if (user === undefined) {
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
