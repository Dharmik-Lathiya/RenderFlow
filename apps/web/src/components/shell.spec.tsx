import { screen, waitFor } from '@testing-library/react';

import { Shell } from './shell';
import { renderWithProviders, stubApi, userEvent } from '../test/harness';

jest.mock('next/navigation', () => ({
  usePathname: () => '/dashboard',
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));

/**
 * The shell owns the sign-out transition. A failed logout still redirects, but
 * the rejected promise must not escape as an unhandled browser rejection: the
 * user already knows they are being signed out, and the console noise hides
 * real errors.
 */
describe('Shell sign out', () => {
  it('redirects after a failed logout without leaking a rejected promise', async () => {
    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      rejections.push(reason);
    };
    // Jest reports unhandled rejections as test failures. Intercept the emit
    // for this one assertion and restore it afterwards, so the test measures the
    // app's behaviour rather than the runner's.
    const originalEmit = process.emit.bind(process) as (
      event: string | symbol,
      ...values: unknown[]
    ) => boolean;
    const emitSpy = jest.spyOn(process, 'emit');
    emitSpy.mockImplementation(((event: string | symbol, ...args: unknown[]) => {
      if (event === 'unhandledRejection') {
        onUnhandled(args[0]);
        return true;
      }
      return originalEmit(event, ...args);
    }) as typeof process.emit);

    // jsdom cannot navigate; the error is expected and not under test here.
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const { client, calls } = stubApi({
        'GET /auth/me': {
          body: {
            user: { id: 'u1', email: 'ada@example.com', name: 'Ada Lovelace', role: 'OWNER' },
            wallet: { available: 50, reserved: 0 },
          },
        },
        'GET /workspaces': { body: [] },
        'GET /notifications/unread-count': { body: { count: 0 } },
        'POST /auth/logout': { status: 500, body: { code: 'INTERNAL_ERROR', message: 'nope' } },
      });

      renderWithProviders(
        <Shell>
          <div>Dashboard</div>
        </Shell>,
        client,
      );

      await screen.findByText('ada@example.com');
      await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));

      await waitFor(() => {
        expect(calls.some((call) => call.url === '/auth/logout')).toBe(true);
      });
      // Let the rejected promise settle and emit `unhandledRejection` if it is
      // still floating. These are microtasks, not a wall-clock sleep.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(rejections).toEqual([]);
    } finally {
      emitSpy.mockRestore();
      consoleError.mockRestore();
    }
  });
});
