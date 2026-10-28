'use client';

import Link from 'next/link';
import { useState } from 'react';

import { useApi } from '../../../lib/providers';
import { Button, Card } from '../../../components/ui';
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
    <div className={styles.authCard}>
      <Card title="Confirm your email" description="One click, and this address is verified.">
        {token === '' ? (
          <div role="alert">
            <p>This page needs a verification link. Open the link from your email.</p>
            <p>
              <Link href="/login">Sign in</Link>
            </p>
          </div>
        ) : state === 'done' ? (
          <div role="status">
            <p>Your address is confirmed.</p>
            <p>
              <Link href="/dashboard">Go to the dashboard</Link>
            </p>
          </div>
        ) : state === 'failed' ? (
          <div role="alert">
            <p>
              This link has expired or has already been used. Sign in and request a new one from
              your account settings.
            </p>
            <p>
              <Link href="/login">Sign in</Link>
            </p>
          </div>
        ) : (
          <>
            <Button
              type="button"
              variant="primary"
              busy={state === 'busy'}
              onClick={() => void confirm()}
            >
              Confirm this address
            </Button>
          </>
        )}
      </Card>
    </div>
  );
}
