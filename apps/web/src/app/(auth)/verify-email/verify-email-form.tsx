'use client';

import Link from 'next/link';
import { useState } from 'react';

import { useApi } from '../../../lib/providers';
import { AuthShell } from '../../../components/auth-shell';
import { Icon } from '../../../components/icons';
import { Button } from '../../../components/ui';
import styles from '../../../components/ui.module.css';

/**
 * Confirm an address.
 *
 * Confirmation is a click, not an effect on mount, and that is deliberate: mail
 * clients and security scanners pre-fetch links in email. A page that consumed
 * the token on load would burn the user's link before they ever saw it, and the
 * token is single-use by design.
 */
export function VerifyEmailForm({ token }: { token: string }) {
  const api = useApi();
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'failed'>('idle');

  const confirm = async (): Promise<void> => {
    setState('busy');
    try {
      await api.auth.verifyEmail(token);
      setState('done');
    } catch {
      setState('failed');
    }
  };

  return (
    <AuthShell
      eyebrow="Email"
      title="Confirm your email"
      description="One click, and this address is verified."
      footer={
        <p className={styles.authSwitch}>
          <Link href="/login">Back to sign in</Link>
        </p>
      }
    >
      {token === '' ? (
        <div className={styles.authNotice} role="alert">
          <span className={styles.authNoticeIcon}>
            <Icon name="alert" size={16} />
          </span>
          <div>
            <p>
              <strong>This page needs a verification link.</strong>
            </p>
            <p>
              Open the link from your email, then try again. <Link href="/login">Sign in</Link>.
            </p>
          </div>
        </div>
      ) : state === 'done' ? (
        <div className={`${styles.authNotice} ${styles.authNoticeSuccess}`} role="status">
          <span className={styles.authNoticeIcon}>
            <Icon name="check" size={16} />
          </span>
          <div>
            <p>
              <strong>Your address is confirmed.</strong>
            </p>
            <p>
              <Link href="/dashboard">Go to the dashboard</Link>.
            </p>
          </div>
        </div>
      ) : state === 'failed' ? (
        <div className={styles.authNotice} role="alert">
          <span className={styles.authNoticeIcon}>
            <Icon name="alert" size={16} />
          </span>
          <div>
            <p>
              <strong>This link has expired or has already been used.</strong>
            </p>
            <p>
              Sign in and request a new one from your account settings.{' '}
              <Link href="/login">Sign in</Link>.
            </p>
          </div>
        </div>
      ) : (
        <div className={styles.authActions}>
          <Button
            type="button"
            variant="primary"
            busy={state === 'busy'}
            onClick={() => void confirm()}
          >
            Confirm this address
          </Button>
        </div>
      )}
    </AuthShell>
  );
}
