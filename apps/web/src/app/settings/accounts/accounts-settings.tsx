'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { ApiClientError } from '@renderflow/api-client';

import { useApi } from '../../../lib/providers';
import { Icon } from '../../../components/icons';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  Field,
  PageHeader,
  Spinner,
  StatCard,
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

  const list = accounts.data ?? [];
  const platforms = new Set(list.map((account) => account.platform));
  const reconnectCount = list.filter((account) => account.needsReconnect).length;
  const freshConnections = list.filter((account) => {
    const created = new Date(account.createdAt).getTime();
    return Number.isFinite(created) && Date.now() - created < 30 * 24 * 60 * 60 * 1000;
  }).length;

  return (
    <>
      <PageHeader
        eyebrow="Settings"
        title="Accounts"
        description="Connect the social channels RenderFlow publishes to. Tokens are encrypted at rest and never returned by the API."
        actions={
          <a href="#connect-account" className={`${styles.button} ${styles.primary}`}>
            <Icon name="plus" size={15} />
            Connect an account
          </a>
        }
      />

      <div className={styles.kpiGrid}>
        <StatCard
          label="Connected"
          value={accounts.data === undefined ? '—' : list.length}
          hint="channels ready to publish"
          icon={<Icon name="accounts" />}
        />
        <StatCard
          label="Platforms"
          value={accounts.data === undefined ? '—' : platforms.size}
          hint="distinct networks"
          icon={<Icon name="link" />}
          tone="info"
        />
        <StatCard
          label="Needs reconnect"
          value={accounts.data === undefined ? '—' : reconnectCount}
          hint="expired or revoked tokens"
          icon={<Icon name="alert" />}
          tone={reconnectCount > 0 ? 'warning' : 'success'}
        />
        <StatCard
          label="Added recently"
          value={accounts.data === undefined ? '—' : freshConnections}
          hint="in the last 30 days"
          icon={<Icon name="check" />}
          tone="success"
        />
      </div>

      <Card
        title="Connected accounts"
        description="Posts publish to these accounts. Disconnecting one does not delete its history."
      >
        {disconnect.isError && <ErrorNotice message={disconnectMessage(disconnect.error)} />}

        {accounts.isLoading && <Spinner label="Loading accounts" />}

        {accounts.isError && (
          <ErrorNotice message="Could not load accounts." onRetry={() => void accounts.refetch()} />
        )}

        {accounts.data !== undefined && accounts.data.length === 0 && (
          <EmptyState
            icon={<Icon name="accounts" size={18} />}
            title="Nothing connected"
            description="Connect an account before scheduling a post to publish."
            action={
              <a href="#connect-account" className={`${styles.button} ${styles.primary}`}>
                Connect your first account
              </a>
            }
          />
        )}

        {list.length > 0 && (
          <div className={styles.accountGrid}>
            {list.map((account) => (
              <article key={account.id} className={styles.accountCard}>
                <div className={styles.accountCardHead}>
                  <span
                    className={styles.platformBadge}
                    data-platform={account.platform}
                    aria-hidden="true"
                  >
                    {account.platform.slice(0, 2).toUpperCase()}
                  </span>
                  <span className={styles.accountCopy}>
                    <span className={styles.accountName}>
                      {account.displayName ?? account.platform}
                    </span>
                    <span className={styles.accountMeta}>
                      {account.platform} · {account.externalAccountId}
                    </span>
                  </span>
                  {account.needsReconnect && <Badge tone="warn">reconnect needed</Badge>}
                </div>

                <div className={styles.accountFooter}>
                  <span className={styles.accountStatus}>
                    <span
                      className={
                        account.needsReconnect
                          ? `${styles.statusDot} ${styles.statusDotWarn}`
                          : styles.statusDot
                      }
                      aria-hidden="true"
                    />
                    {account.needsReconnect ? 'Reconnect to resume publishing' : 'Ready to publish'}
                  </span>
                  <Button
                    variant="danger"
                    busy={disconnect.isPending && disconnect.variables === account.id}
                    onClick={() => disconnect.mutate(account.id)}
                  >
                    Disconnect
                  </Button>
                </div>
              </article>
            ))}
          </div>
        )}
      </Card>

      <div className={styles.formLayout}>
        <Card
          title="Connect an account"
          description="Use the platform's stable account id. A duplicate connection is refused rather than silently replaced."
        >
          <form
            id="connect-account"
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

        <div className={styles.dashboardColumn}>
          <Card
            title="Token handling"
            description="What happens between this form and the publisher."
          >
            <ul className={styles.miniList}>
              <li className={styles.miniItem}>
                <span className={styles.miniDot} aria-hidden="true" />
                <span className={styles.miniCopy}>
                  <span className={styles.miniTitle}>Encrypted with AES-256-GCM</span>
                  <span className={styles.miniMeta}>
                    The key lives in the API environment, never in the browser.
                  </span>
                </span>
              </li>
              <li className={styles.miniItem}>
                <span className={styles.miniDot} aria-hidden="true" />
                <span className={styles.miniCopy}>
                  <span className={styles.miniTitle}>Never returned to the client</span>
                  <span className={styles.miniMeta}>
                    The API strips tokens from every response.
                  </span>
                </span>
              </li>
              <li className={styles.miniItem}>
                <span className={styles.miniDot} aria-hidden="true" />
                <span className={styles.miniCopy}>
                  <span className={styles.miniTitle}>Disconnect is guarded</span>
                  <span className={styles.miniMeta}>
                    An account with queued posts cannot be removed until they are cancelled.
                  </span>
                </span>
              </li>
            </ul>
          </Card>

          <Card
            title="Need a hand?"
            description="A failed publish is the most common reason to land here."
          >
            <p className={styles.cardDescription}>
              If an account shows <strong>reconnect needed</strong>, its token has expired or been
              revoked. Disconnect it, then connect it again with a fresh token. Scheduled posts keep
              their times and pick the account back up.
            </p>
          </Card>
        </div>
      </div>
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
