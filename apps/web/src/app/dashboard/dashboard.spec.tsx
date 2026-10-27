import { screen, waitFor } from '@testing-library/react';

import { Dashboard } from './dashboard';
import { renderWithProviders, stubApi, userEvent } from '../../test/harness';

/**
 * The dashboard, against a stubbed API.
 *
 * The journey this covers is the one a new user takes first: arrive, see their
 * credits, see whether they have a brand, and be told what to do next if not.
 */

const ME = {
  user: { id: 'u1', email: 'sam@example.com', name: 'Sam', role: 'MEMBER' },
  wallet: { available: 50, reserved: 0 },
};

const WORKSPACES = [{ id: 'w1', name: "Sam's workspace", ownerId: 'u1', role: 'OWNER' }];

describe('Dashboard', () => {
  it('shows the credit balance before anything else', async () => {
    // The balance gates every action; a user who finds out they are out of credits
    // after composing a reel has already wasted the attempt.
    const { client } = stubApi({
      'GET /auth/me': { body: ME },
      'GET /workspaces': { body: WORKSPACES },
      'GET /brands': {
        body: [
          {
            id: 'b1',
            workspaceId: 'w1',
            name: 'Acme',
            industry: 'retail',
            colors: [],
            languages: ['en'],
          },
        ],
      },
    });

    renderWithProviders(<Dashboard />, client);

    expect(await screen.findByRole('heading', { name: 'Credits' })).toBeInTheDocument();
    expect(screen.getByText('50')).toBeInTheDocument();
  });

  it('warns when credits are running low', async () => {
    const { client } = stubApi({
      'GET /auth/me': { body: { ...ME, wallet: { available: 3, reserved: 0 } } },
      'GET /workspaces': { body: WORKSPACES },
      'GET /brands': { body: [] },
    });

    renderWithProviders(<Dashboard />, client);

    expect(await screen.findByText('Running low')).toBeInTheDocument();
  });

  it('shows reserved credits separately from available', async () => {
    // Reserved means work is running now; conflating the two makes the balance
    // look wrong during a generation.
    const { client } = stubApi({
      'GET /auth/me': { body: { ...ME, wallet: { available: 20, reserved: 30 } } },
      'GET /workspaces': { body: WORKSPACES },
      'GET /brands': { body: [] },
    });

    renderWithProviders(<Dashboard />, client);

    expect(await screen.findByText('20')).toBeInTheDocument();
    expect(screen.getByText('30')).toBeInTheDocument();
  });

  it('offers a way in when the visitor is signed out', async () => {
    // Not an error box: this is the landing page for someone with no session.
    const { client } = stubApi({});

    renderWithProviders(<Dashboard />, client);

    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('points a new user at creating a brand', async () => {
    const { client } = stubApi({
      'GET /auth/me': { body: ME },
      'GET /workspaces': { body: WORKSPACES },
      'GET /brands': { body: [] },
    });

    renderWithProviders(<Dashboard />, client);

    expect(await screen.findByText('No brands yet')).toBeInTheDocument();
    expect(
      screen.getAllByRole('link', { name: /create your first brand/i }).length,
    ).toBeGreaterThan(0);
  });

  it('links to each brand the user has', async () => {
    const { client } = stubApi({
      'GET /auth/me': { body: ME },
      'GET /workspaces': { body: WORKSPACES },
      'GET /brands': {
        body: [
          {
            id: 'b1',
            workspaceId: 'w1',
            name: 'Acme',
            industry: 'retail',
            colors: [],
            languages: ['en'],
          },
          {
            id: 'b2',
            workspaceId: 'w1',
            name: 'Northwind',
            industry: 'logistics',
            colors: [],
            languages: ['en'],
          },
        ],
      },
    });

    renderWithProviders(<Dashboard />, client);

    expect(await screen.findByRole('link', { name: 'Acme' })).toHaveAttribute('href', '/brands/b1');
    expect(screen.getByRole('link', { name: 'Northwind' })).toHaveAttribute('href', '/brands/b2');
  });

  it('offers a retry when brands fail to load', async () => {
    // A transient failure with a retry button beats a blank panel: the user
    // cannot tell "you have no brands" from "we could not ask".
    let attempt = 0;
    const { client } = stubApi({
      'GET /auth/me': { body: ME },
      'GET /workspaces': { body: WORKSPACES },
      'GET /brands': () => {
        attempt += 1;
        return attempt === 1
          ? { status: 500, body: { code: 'INTERNAL', message: 'boom' } }
          : { body: [] };
      },
    });

    renderWithProviders(<Dashboard />, client);

    await screen.findByText('Could not load your brands.');

    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));

    await waitFor(() => expect(screen.getByText('No brands yet')).toBeInTheDocument());
    // The error has to actually go away, not just be joined by the content: a
    // stale banner over correct data is what this retry is supposed to prevent.
    expect(screen.queryByText('Could not load your brands.')).toBeNull();
    expect(attempt).toBe(2);
  });

  it('does not request brands before the session is known', async () => {
    // Otherwise every signed-out visitor fires a request that can only 401.
    const { client, calls } = stubApi({
      'GET /auth/me': { status: 401, body: { code: 'UNAUTHORIZED', message: 'no session' } },
    });

    renderWithProviders(<Dashboard />, client);

    await screen.findByRole('button', { name: 'Sign in' });

    expect(calls.filter((call) => call.url.includes('/brands'))).toHaveLength(0);
  });

  it('refuses to render a response it does not understand', async () => {
    // The api-client's parse failure. A missing field must not silently become
    // `undefined` on screen.
    const { client } = stubApi({
      'GET /auth/me': { body: { user: { id: 'u1', email: 'sam@example.com', role: 'MEMBER' } } },
      'GET /brands': { body: [] },
    });

    renderWithProviders(<Dashboard />, client);

    // The 200 with a bad body is an error, not a session.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument(),
    );
  });
});
