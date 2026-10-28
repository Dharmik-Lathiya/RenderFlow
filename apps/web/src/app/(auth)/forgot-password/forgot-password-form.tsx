'use client';

import Link from 'next/link';
import { useState } from 'react';

import { useApi } from '../../../lib/providers';
import { Button, Card, Field } from '../../../components/ui';
import styles from '../../../components/ui.module.css';

/**
 * Request a reset link.
 *
 * The confirmation is deliberately identical whether or not the address exists,
 * matching the API's 202-for-everything policy. A message like "no account with
 * that email" would turn this page into the account oracle the endpoint refuses
 * to be.
 */
export function ForgotPasswordForm() {
  const api = useApi();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setError(null);
    setBusy(true);

    try {
      await api.auth.forgotPassword(email.trim());
      setSent(true);
    } catch {
      // The one failure worth surfacing is the transport: a 500 means the mail
      // may not have been queued at all, which is different from "no such user".
      setError('We could not reach the server. Please try again in a moment.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.authCard}>
      <Card
        title="Reset your password"
        description="We will email you a link. It works once, and expires in 30 minutes."
      >
        {sent ? (
          <div role="status">
            <p>
              If an account exists for <strong>{email.trim()}</strong>, the link is on its way.
              Check the spam folder if it has not arrived in a few minutes.
            </p>
            <p>
              <Link href="/login">Back to sign in</Link>
            </p>
          </div>
        ) : (
          <form className={styles.authForm} onSubmit={(event) => void onSubmit(event)} noValidate>
            <Field label="Email" id="email">
              {({ id, describedBy, invalid }) => (
                <input
                  id={id}
                  type="email"
                  autoComplete="email"
                  aria-describedby={describedBy}
                  aria-invalid={invalid || undefined}
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  required
                />
              )}
            </Field>

            {error === null ? null : <p role="alert">{error}</p>}

            <Button type="submit" variant="primary" busy={busy}>
              Send reset link
            </Button>
          </form>
        )}

        <p>
          <Link href="/login">Back to sign in</Link>
        </p>
      </Card>
    </div>
  );
}
