import { screen, waitFor } from '@testing-library/react';

import { AccountMenu } from './account-menu';
import { renderWithProviders, stubApi, userEvent } from '../test/harness';

/**
 * The account popover.
 *
 * Two behaviours matter beyond "it opens": a phone has no sidebar, so signing
 * out must be reachable from this menu, and Escape must return focus to the
 * trigger rather than dropping it at the top of the document.
 */

describe('AccountMenu', () => {
  it('shows the account and signs out', async () => {
    const onSignOut = jest.fn();
    const { client } = stubApi({});

    renderWithProviders(
      <AccountMenu
        user={{ name: 'Ada Lovelace', email: 'ada@example.com' }}
        wallet={{ available: 50, reserved: 5 }}
        initials="AL"
        onSignOut={onSignOut}
      />,
      client,
    );

    const trigger = screen.getByRole('button', { name: 'Account menu' });
    await userEvent.click(trigger);

    expect(screen.getByText('ada@example.com')).toBeVisible();
    expect(screen.getByText('50')).toBeVisible();
    expect(trigger).toHaveAttribute('aria-expanded', 'true');

    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape and returns focus to the trigger', async () => {
    const { client } = stubApi({});

    renderWithProviders(
      <AccountMenu
        user={{ name: 'Ada Lovelace', email: 'ada@example.com' }}
        initials="AL"
        onSignOut={jest.fn()}
      />,
      client,
    );

    const trigger = screen.getByRole('button', { name: 'Account menu' });
    await userEvent.click(trigger);
    await userEvent.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByText('ada@example.com')).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });
});
