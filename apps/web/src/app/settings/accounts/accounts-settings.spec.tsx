import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { AccountsSettings } from './accounts-settings';
import { renderWithProviders, stubApi } from '../../../test/harness';

/**
 * Connected accounts.
 *
 * The property worth the most attention here is the one the screen CANNOT show:
 * that a token, once sent, is never handed back. It is asserted against the
 * rendered DOM rather than against the API's response shape alone, because the
 * failure that matters is a token reaching the page.
 */

const ACCOUNT = {
  id: 'a1',
  workspaceId: 'w1',
  platform: 'linkedin',
  externalAccountId: 'ext-1',
  displayName: 'Acme Ltd',
  scopes: ['publish'],
  tokenExpiresAt: null,
  connectedBy: 'u1',
  createdAt: '2026-01-01T00:00:00.000Z',
  needsReconnect: false,
};

const WORKSPACES = [{ id: 'w1', name: 'Acme', ownerId: 'u1', role: 'OWNER' }];

describe('AccountsSettings', () => {
  it('lists what is connected', async () => {
    const { client } = stubApi({
      'GET /workspaces': { body: WORKSPACES },
      'GET /social-accounts': { body: [ACCOUNT] },
    });

    renderWithProviders(<AccountsSettings />, client);

    expect(await screen.findByText('Acme Ltd')).toBeInTheDocument();
    expect(screen.getByText(/ext-1/)).toBeInTheDocument();
  });

  it('never renders a token, even if the server sends one', async () => {
    // The defence in depth. The API does not return tokens, and the client's
    // schema strips unknown keys - so a regression on either side still cannot
    // put a credential on the page.
    const { client } = stubApi({
      'GET /workspaces': { body: WORKSPACES },
      'GET /social-accounts': { body: [{ ...ACCOUNT, token: 'ya29.super-secret' }] },
    });

    renderWithProviders(<AccountsSettings />, client);

    await screen.findByText('Acme Ltd');

    expect(document.body.textContent).not.toContain('ya29.super-secret');
  });

  it('does not pre-fill the token field with what was stored', async () => {
    const { client } = stubApi({
      'GET /workspaces': { body: WORKSPACES },
      'GET /social-accounts': { body: [ACCOUNT] },
    });

    renderWithProviders(<AccountsSettings />, client);

    const input: HTMLInputElement = await screen.findByLabelText('Access token');

    // A pre-filled token field is a token on screen, whatever the API did.
    expect(input.value).toBe('');
    expect(input.type).toBe('password');
  });

  it('marks an account whose token expired as needing a reconnect', async () => {
    const { client } = stubApi({
      'GET /workspaces': { body: WORKSPACES },
      'GET /social-accounts': { body: [{ ...ACCOUNT, needsReconnect: true }] },
    });

    renderWithProviders(<AccountsSettings />, client);

    // The only thing the user can act on about a failed publish.
    expect(await screen.findByText('reconnect needed')).toBeInTheDocument();
  });

  it('sends the token on connect and clears the field afterwards', async () => {
    const { client, calls } = stubApi({
      'GET /workspaces': { body: WORKSPACES },
      'GET /social-accounts': { body: [] },
      'POST /social-accounts': { body: ACCOUNT },
    });

    renderWithProviders(<AccountsSettings />, client);

    await screen.findByRole('button', { name: 'Connect' });

    await userEvent.type(screen.getByLabelText('Platform account id'), 'ext-1');
    await userEvent.type(screen.getByLabelText('Access token'), 'ya29.secret');
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }));

    await waitFor(() =>
      expect(calls.some((call) => call.url === '/social-accounts' && call.method === 'POST')).toBe(
        true,
      ),
    );

    const sent = calls.find((call) => call.url === '/social-accounts' && call.method === 'POST');
    expect(sent?.body).toMatchObject({
      workspaceId: 'w1',
      platform: 'linkedin',
      accessToken: 'ya29.secret',
    });

    // Cleared, so the value is not left sitting in a DOM node after the request.
    const after: HTMLInputElement = screen.getByLabelText('Access token');
    await waitFor(() => expect(after.value).toBe(''));
  });

  it('refuses to submit without a token and says why', async () => {
    const { client, calls } = stubApi({
      'GET /workspaces': { body: WORKSPACES },
      'GET /social-accounts': { body: [] },
    });

    renderWithProviders(<AccountsSettings />, client);

    await userEvent.type(screen.getByLabelText('Platform account id'), 'ext-1');
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }));

    expect(await screen.findByText('A token is required.')).toBeInTheDocument();
    expect(calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('explains a duplicate connection rather than saying "conflict"', async () => {
    const { client } = stubApi({
      'GET /workspaces': { body: WORKSPACES },
      'GET /social-accounts': { body: [] },
      'POST /social-accounts': {
        status: 409,
        body: { code: 'CONFLICT', message: 'already connected' },
      },
    });

    renderWithProviders(<AccountsSettings />, client);

    await userEvent.type(screen.getByLabelText('Platform account id'), 'ext-1');
    await userEvent.type(screen.getByLabelText('Access token'), 'ya29.secret');
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }));

    expect(await screen.findByText('That account is already connected.')).toBeInTheDocument();
  });

  it('refuses to disconnect an account with posts still queued', async () => {
    const { client } = stubApi({
      'GET /workspaces': { body: WORKSPACES },
      'GET /social-accounts': { body: [ACCOUNT] },
      'DELETE /social-accounts/{accountId}': {
        status: 409,
        body: {
          code: 'CONFLICT',
          message: 'this account has posts still scheduled; cancel them first',
        },
      },
    });

    renderWithProviders(<AccountsSettings />, client);

    await userEvent.click(await screen.findByRole('button', { name: 'Disconnect' }));

    // The user needs the API's reason verbatim: "cancel them first" is the
    // action, and paraphrasing it into "could not disconnect" loses it.
    expect(await screen.findByText(/cancel them first/i)).toBeInTheDocument();
  });

  it('invites a connection when there is none', async () => {
    const { client } = stubApi({
      'GET /workspaces': { body: WORKSPACES },
      'GET /social-accounts': { body: [] },
    });

    renderWithProviders(<AccountsSettings />, client);

    expect(await screen.findByText('Nothing connected')).toBeInTheDocument();
  });
});
