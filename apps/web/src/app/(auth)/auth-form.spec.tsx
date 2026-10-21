import { fireEvent, screen, waitFor } from '@testing-library/react';

import { AuthForm } from './auth-form';
import { renderWithProviders, stubApi } from '../../test/harness';

/**
 * The register form used to send only email and password, while the API
 * requires a name. The request failed validation after the user had filled a
 * form that never asked for the missing field - a dead end with no way for them
 * to recover.
 */
describe('AuthForm', () => {
  it('sends the name when registering', async () => {
    const { client, calls } = stubApi({
      'POST /auth/register': {
        status: 409,
        body: { code: 'EMAIL_ALREADY_REGISTERED', message: 'This email is already registered.' },
      },
    });

    renderWithProviders(<AuthForm mode="register" />, client);

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Ada Lovelace' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'ada@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'Correct-Horse-1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));

    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    expect(calls[0]?.body).toEqual({
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      password: 'Correct-Horse-1',
    });
  });

  it('does not ask for a name when signing in', () => {
    const { client } = stubApi({});

    renderWithProviders(<AuthForm mode="login" />, client);

    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
  });

  it('blocks registration until a name is entered', () => {
    const { client, calls } = stubApi({});

    renderWithProviders(<AuthForm mode="register" />, client);

    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'ada@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'Correct-Horse-1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));

    expect(screen.getByText('Enter your name.')).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });
});
