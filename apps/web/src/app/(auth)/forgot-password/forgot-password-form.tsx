'use client';

import Link from 'next/link';
import { useState } from 'react';

import { useApi } from '../../../lib/providers';
import { AuthShell } from '../../../components/auth-shell';
import { Icon } from '../../../components/icons';
import { Button, ErrorNotice, Field } from '../../../components/ui';
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
    <AuthShell
      eyebrow="Account recovery"
      title="Reset your password"
      description="We will email you a link. It works once, and expires in 30 minutes."
      footer={
        <p className={styles.authSwitch}>
          Remembered it? <Link href="/login">Back to sign in</Link>
        </p>
      }
    >
      {sent ? (
        <div className={`${styles.authNotice} ${styles.authNoticeSuccess}`} role="status">
          <span className={styles.authNoticeIcon}>
            <Icon name="check" size={16} />
          </span>
          <div>
            <p>
              <strong>Check your inbox.</strong>
            </p>
            <p>
              If an account exists for <strong>{email.trim()}</strong>, the link is on its way.
              Check the spam folder if it has not arrived in a few minutes.
            </p>
          </div>
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

          {error === null ? null : <ErrorNotice message={error} />}

          <div className={styles.authActions}>
            <Button type="submit" variant="primary" busy={busy}>
              Send reset link
            </Button>
          </div>
        </form>
      )}
    </AuthShell>
  );
}
