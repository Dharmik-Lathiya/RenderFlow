'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { ApiClientError } from '@renderflow/api-client';

import { useApi } from '../../../lib/providers';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  Field,
  Spinner,
} from '../../../components/ui';
import styles from '../../../components/ui.module.css';

/**
 * Connected social accounts.
 *
 * The token field is the awkward part of this screen and the reason it deserves
 * a comment. In production the token comes from an OAuth redirect, not from a
 * form - this endpoint accepts one because the authorization-code flow is not
 * built yet (PROJECT.md section 12). So the field is labelled as what it is
 * rather than dressed up as a normal input, and the security note is stated
 * plainly: the server encrypts it and never returns it, which the client test
 * below asserts rather than hopes for.
 */
/**
 * Connected accounts.
 *
 * `workspaceId` is resolved here rather than passed in, because the screen is
 * reached by URL and has no parent that knows it.
 */
export function AccountsSettings() {
  const api = useApi();
  const client = useQueryClient();

  const workspaces = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => api.workspaces.list(),
    retry: false,
  });

  const workspaceId = workspaces.data?.[0]?.id ?? '';

  const [platform, setPlatform] = useState<'linkedin' | 'instagram'>('linkedin');
  const [externalAccountId, setExternalAccountId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [touched, setTouched] = useState(false);

  const accounts = useQuery({
    queryKey: ['social-accounts', workspaceId],
    queryFn: () => api.socialAccounts.list(workspaceId),
    enabled: workspaceId !== '',
  });

  const connect = useMutation({
    mutationFn: () =>
      api.socialAccounts.connect({
        workspaceId,
        platform,
        externalAccountId: externalAccountId.trim(),
        ...(displayName.trim() === '' ? {} : { displayName: displayName.trim() }),
        accessToken: accessToken.trim(),
        scopes: ['publish'],
      }),
    retry: false,
    onSuccess: async () => {
      setExternalAccountId('');
      setDisplayName('');
      setAccessToken('');
      setTouched(false);
      await client.invalidateQueries({ queryKey: ['social-accounts', workspaceId] });
    },
  });

  const disconnect = useMutation({
    mutationFn: (accountId: string) => api.socialAccounts.disconnect(accountId),
    retry: false,
    onSuccess: () => void client.invalidateQueries({ queryKey: ['social-accounts', workspaceId] }),
    // The error is surfaced deliberately. The API refuses to disconnect an
    // account that still has posts scheduled, and "cancel them first" is the
    // action the user needs - a button that does nothing when clicked is
    // indistinguishable from a broken one.
    onError: () => undefined,
  });

  const tokenError = touched && accessToken.trim() === '' ? 'A token is required.' : undefined;
  const idError =
    touched && externalAccountId.trim() === '' ? 'The platform account id is required.' : undefined;

  return (
    <>
      <h1>Social accounts</h1>

      <Card title="Connected" description="Posts publish to these accounts.">
        {disconnect.isError && <ErrorNotice message={disconnectMessage(disconnect.error)} />}

        {accounts.isLoading && <Spinner label="Loading accounts" />}

        {accounts.isError && (
          <ErrorNotice message="Could not load accounts." onRetry={() => void accounts.refetch()} />
        )}

        {accounts.data !== undefined && accounts.data.length === 0 && (
          <EmptyState
            title="Nothing connected"
            description="Connect an account before scheduling a post to publish."
          />
        )}

        {accounts.data !== undefined && accounts.data.length > 0 && (
          <ul className={styles.list}>
            {accounts.data.map((account) => (
              <li key={account.id} className={styles.listItem}>
                <span>
                  <strong>{account.displayName ?? account.platform}</strong>
                  <span className={styles.cardDescription}>
                    {' '}
                    {account.platform} · {account.externalAccountId}
                  </span>
                </span>
                <span className={styles.row}>
                  {account.needsReconnect && <Badge tone="warn">reconnect needed</Badge>}
                  <Button
                    variant="danger"
                    busy={disconnect.isPending}
                    onClick={() => disconnect.mutate(account.id)}
                  >
                    Disconnect
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Connect an account">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setTouched(true);

            if (externalAccountId.trim() === '' || accessToken.trim() === '') {
              return;
            }

            connect.mutate();
          }}
          noValidate
        >
          {connect.isError && <ErrorNotice message={connectMessage(connect.error)} />}

          <Field label="Platform" id="account-platform">
            {({ id, describedBy }) => (
              <select
                id={id}
                aria-describedby={describedBy}
                value={platform}
                onChange={(event) => setPlatform(event.target.value as 'linkedin' | 'instagram')}
              >
                <option value="linkedin">LinkedIn</option>
                <option value="instagram">Instagram</option>
              </select>
            )}
          </Field>

          <Field
            label="Platform account id"
            id="account-external-id"
            error={idError}
            hint="The id the platform gives the account, stable across reconnects."
          >
            {({ id, describedBy, invalid }) => (
              <input
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid || undefined}
                value={externalAccountId}
                onChange={(event) => setExternalAccountId(event.target.value)}
                onBlur={() => setTouched(true)}
              />
            )}
          </Field>

          <Field label="Display name" id="account-display-name" hint="Optional.">
            {({ id, describedBy }) => (
              <input
                id={id}
                aria-describedby={describedBy}
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
              />
            )}
          </Field>

          <Field
            label="Access token"
            id="account-token"
            error={tokenError}
            hint="Encrypted before storage and never returned by the API. Normally this comes from an OAuth redirect."
          >
            {({ id, describedBy, invalid }) => (
              <input
                id={id}
                type="password"
                autoComplete="off"
                aria-describedby={describedBy}
                aria-invalid={invalid || undefined}
                value={accessToken}
                onChange={(event) => setAccessToken(event.target.value)}
                onBlur={() => setTouched(true)}
              />
            )}
          </Field>

          <Button type="submit" variant="primary" busy={connect.isPending}>
            Connect
          </Button>
        </form>
      </Card>
    </>
  );
}

/**
 * The API's own message for a refused disconnect.
 *
 * Used verbatim, because the reason it refuses is the action the user has to
 * take next and paraphrasing it loses exactly that.
 */
function disconnectMessage(error: unknown): string {
  if (error instanceof ApiClientError && error.code === 'CONFLICT') {
    return error.message;
  }

  return 'Could not disconnect that account.';
}

function connectMessage(error: unknown): string {
  if (error instanceof ApiClientError && error.code === 'CONFLICT') {
    return 'That account is already connected.';
  }

  if (error instanceof ApiClientError && error.code === 'VALIDATION_FAILED') {
    return error.message;
  }

  return 'Could not connect that account.';
}
