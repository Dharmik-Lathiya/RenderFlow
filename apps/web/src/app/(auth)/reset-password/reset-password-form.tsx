'use client';

import Link from 'next/link';
import { useState } from 'react';

import { ApiClientError } from '@renderflow/api-client';

import { useApi } from '../../../lib/providers';
import { Button, Card, Field } from '../../../components/ui';
import styles from '../../../components/ui.module.css';

/**
 * Choose a new password.
 *
 * The policy text is the same one registration shows, because the API applies the
 * same policy - a reset that accepts a weaker password is a way to downgrade an
 * account.
 *
 * A used or expired link is reported as exactly that, and the user is sent back to
 * request a new one. The API deliberately does not distinguish "never existed"
 * from "already used", so the page cannot either.
 */
export function ResetPasswordForm({ token }: { token: string }) {
  const api = useApi();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const mismatch = confirm !== '' && confirm !== password;

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setError(null);

    if (password !== confirm) {
      setError('The two passwords do not match.');
      return;
    }

    setBusy(true);
    try {
      await api.auth.resetPassword(token, password);
      setDone(true);
    } catch (caught) {
      setError(
        caught instanceof ApiClientError && caught.code === 'INVALID_TOKEN'
          ? 'This link has expired or has already been used. Request a new one.'
          : 'We could not reset the password. Please try again.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.authCard}>
      <Card
        title="Choose a new password"
        description="Signing in again will be required everywhere."
      >
        {token === '' ? (
          <div role="alert">
            <p>
              This page needs a reset link. Open the link from your email, or request a new one.
            </p>
            <p>
              <Link href="/forgot-password">Request a reset link</Link>
            </p>
          </div>
        ) : done ? (
          <div role="status">
            <p>Your password has been changed, and every other session has been signed out.</p>
            <p>
              <Link href="/login">Sign in with the new password</Link>
            </p>
          </div>
        ) : (
          <form className={styles.authForm} onSubmit={(event) => void onSubmit(event)} noValidate>
            <Field
              label="New password"
              id="password"
              hint="At least 10 characters, including upper and lower case and a number."
            >
              {({ id, describedBy, invalid }) => (
                <input
                  id={id}
                  type="password"
                  autoComplete="new-password"
                  aria-describedby={describedBy}
                  aria-invalid={invalid || undefined}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                />
              )}
            </Field>

            <Field
              label="Confirm new password"
              id="confirm"
              error={mismatch ? 'The two passwords do not match.' : undefined}
            >
              {({ id, describedBy, invalid }) => (
                <input
                  id={id}
                  type="password"
                  autoComplete="new-password"
                  aria-describedby={describedBy}
                  aria-invalid={invalid || undefined}
                  value={confirm}
                  onChange={(event) => setConfirm(event.target.value)}
                  required
                />
              )}
            </Field>

            {error === null ? null : <p role="alert">{error}</p>}

            <Button type="submit" variant="primary" busy={busy}>
              Set new password
            </Button>
          </form>
        )}

        <p>
          <Link href="/forgot-password">Request a new link</Link>
        </p>
      </Card>
    </div>
  );
}
