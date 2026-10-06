import { AppError, ERROR_CODES } from '@renderflow/common';

import { UsersService } from './users.service';

/**
 * `UsersService` is the only place `GET /me` reads a user. Two properties matter:
 * it must never return `passwordHash`, and it must treat a missing account as
 * unauthenticated rather than as a 404 that reveals the token was valid.
 */

interface FakeUser {
  findUnique: jest.Mock;
}

async function serviceWith(prisma: unknown): Promise<UsersService> {
  const service = new UsersService();
  (service as unknown as { prisma: unknown }).prisma = prisma;
  return service;
}

const USER = {
  id: 'user-1',
  email: 'founder@example.com',
  name: 'Ada',
  role: 'MEMBER',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
};

describe('UsersService', () => {
  it('returns the public profile with an ISO timestamp', async () => {
    const findUnique: FakeUser = { findUnique: jest.fn().mockResolvedValue(USER) };
    const service = await serviceWith({ user: findUnique });

    const me = await service.getMe('user-1');

    expect(me).toEqual({
      id: 'user-1',
      email: 'founder@example.com',
      name: 'Ada',
      role: 'MEMBER',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('selects fields explicitly, so passwordHash cannot leak', () => {
    // The strongest guard is structural: passwordHash is never even selected.
    const findUnique: FakeUser = { findUnique: jest.fn().mockResolvedValue(USER) };
    const service = new UsersService();
    (service as unknown as { prisma: unknown }).prisma = { user: findUnique };

    void service.getMe('user-1');

    const select = findUnique.findUnique.mock.calls[0]?.[0]?.select as Record<string, boolean>;
    expect(select).toBeDefined();
    expect(select.passwordHash).toBeUndefined();
    expect(select).toMatchObject({ id: true, email: true, name: true, role: true });
  });

  it('scopes the lookup to the authenticated user id', async () => {
    const findUnique: FakeUser = { findUnique: jest.fn().mockResolvedValue(USER) };
    const service = await serviceWith({ user: findUnique });

    await service.getMe('user-42');

    expect(findUnique.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'user-42' } }),
    );
  });

  it('throws 401 when the account no longer exists', async () => {
    // A valid token for a deleted account must not become a 404, which would
    // confirm the token was legitimate.
    const findUnique: FakeUser = { findUnique: jest.fn().mockResolvedValue(null) };
    const service = await serviceWith({ user: findUnique });

    const error = await service.getMe('ghost').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(ERROR_CODES.UNAUTHORIZED);
    expect((error as AppError).httpStatus).toBe(401);
  });
});
